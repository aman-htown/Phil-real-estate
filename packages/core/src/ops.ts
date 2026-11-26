/**
 * Domain operations shared by the worker and the web UI.
 *
 * The two apps never call each other directly. They coordinate through these
 * tables:
 *  - inbound messages set `conversations.pending_reply_at`; the worker's
 *    responder picks up due conversations and asks Claude for a reply.
 *  - anything to send is inserted into `messages` with status 'queued'; the
 *    worker's outbox sends it through the active WhatsApp transport.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  contacts,
  conversations,
  drafts,
  messages,
  type Message,
  type MessageSource,
  type MessageStatus,
} from "./schema";
import { effectiveMode, getSettings } from "./settings";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
export type Executor = Database | Tx;

export function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function upsertContactAndConversation(
  tx: Executor,
  input: { waId: string; phone?: string | null; profileName?: string | null },
  reopen: boolean,
) {
  const [contact] = await tx
    .insert(contacts)
    .values({ waId: input.waId, phone: input.phone ?? null, profileName: input.profileName ?? null })
    .onConflictDoUpdate({
      target: contacts.waId,
      set: {
        phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
        profileName: sql`coalesce(excluded.profile_name, ${contacts.profileName})`,
      },
    })
    .returning();
  if (!contact) throw new Error("contact upsert failed");

  const [conversation] = await tx
    .insert(conversations)
    .values({ contactId: contact.id })
    .onConflictDoUpdate({
      target: conversations.contactId,
      // A new inbound message re-opens an archived conversation.
      set: reopen ? { status: "open" } : { contactId: sql`excluded.contact_id` },
    })
    .returning();
  if (!conversation) throw new Error("conversation upsert failed");
  return { contact, conversation };
}

export interface InboundInput {
  waId: string;
  phone?: string | null;
  profileName?: string | null;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

export interface IngestResult {
  duplicate: boolean;
  conversationId: string;
  messageId?: string;
}

/**
 * Stores a message from a contact and schedules a reply.
 * Idempotent on `waMessageId`, so webhook redeliveries are harmless.
 */
export async function ingestInbound(db: Database, input: InboundInput): Promise<IngestResult> {
  const settings = await getSettings(db);
  return db.transaction(async (tx) => {
    const { conversation } = await upsertContactAndConversation(tx, input, true);

    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        direction: "inbound",
        source: "contact",
        status: "received",
        type: input.type,
        body: input.body,
        meta: input.meta ?? null,
        waMessageId: input.waMessageId,
        createdAt: input.timestamp,
        sentAt: input.timestamp,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning();
    if (!message) return { duplicate: true, conversationId: conversation.id };

    const mode = effectiveMode(conversation, settings);
    const replyAt = new Date(Date.now() + settings.debounceSeconds * 1000);
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${input.timestamp.toISOString()}::timestamptz)`,
        lastMessagePreview: preview(input.body || `[${input.type}]`),
        lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${input.timestamp.toISOString()}::timestamptz)`,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        // Debounce: every new message pushes the reply back. Emoji reactions don't need a reply.
        ...(mode === "off" || input.type === "reaction" ? {} : { pendingReplyAt: replyAt }),
      })
      .where(eq(conversations.id, conversation.id));

    return { duplicate: false, conversationId: conversation.id, messageId: message.id };
  });
}

export interface ExternalOutboundInput {
  waId: string;
  phone?: string | null;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

/**
 * Records a message the business account sent from outside this system (e.g.
 * Phil typing on his phone while the worker is linked via WhatsApp Web).
 * A human has replied, so any pending AI reply is cancelled.
 */
export async function recordExternalOutbound(
  db: Database,
  input: ExternalOutboundInput,
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    // Our own sends echo back too; skip anything we already know about.
    const existing = await tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.waMessageId, input.waMessageId));
    if (existing[0]) return { duplicate: true, conversationId: existing[0].conversationId };

    const { conversation } = await upsertContactAndConversation(tx, input, false);
    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        direction: "outbound",
        source: "external",
        status: "sent",
        type: input.type,
        body: input.body,
        meta: input.meta ?? null,
        waMessageId: input.waMessageId,
        createdAt: input.timestamp,
        sentAt: input.timestamp,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning();
    if (!message) return { duplicate: true, conversationId: conversation.id };

    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${input.timestamp.toISOString()}::timestamptz)`,
        lastMessagePreview: preview(input.body || `[${input.type}]`),
        pendingReplyAt: null,
        pendingReplyManual: false,
        unreadCount: 0,
      })
      .where(eq(conversations.id, conversation.id));
    await supersedePendingDrafts(tx, conversation.id);
    return { duplicate: false, conversationId: conversation.id, messageId: message.id };
  });
}

async function supersedePendingDrafts(tx: Executor, conversationId: string, exceptId?: string) {
  await tx
    .update(drafts)
    .set({ status: "superseded" })
    .where(
      and(
        eq(drafts.conversationId, conversationId),
        eq(drafts.status, "pending"),
        exceptId ? sql`${drafts.id} <> ${exceptId}` : undefined,
      ),
    );
}

export interface QueueOutboundInput {
  conversationId: string;
  body: string;
  source: Extract<MessageSource, "ai_auto" | "ai_approved" | "human">;
  draftId?: string | null;
  author?: string | null;
}

/** Puts a text message in the outbox. The worker sends it within a couple of seconds. */
export async function queueOutbound(db: Executor, input: QueueOutboundInput): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new Error("Message body is empty");
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: "outbound",
      source: input.source,
      status: "queued",
      type: "text",
      body,
      draftId: input.draftId ?? null,
      author: input.author ?? null,
    })
    .returning();
  if (!message) throw new Error("Could not queue message");

  await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: preview(body),
      unreadCount: 0,
      // Someone replied; no need for the AI to reply again until the contact writes back.
      ...(input.source === "human" ? { pendingReplyAt: null, pendingReplyManual: false } : {}),
    })
    .where(eq(conversations.id, input.conversationId));
  if (input.source === "human") await supersedePendingDrafts(db, input.conversationId);
  return message;
}

/** A human sends (optionally edited) draft text. */
export async function approveDraft(
  db: Database,
  draftId: string,
  opts: { body?: string; author?: string | null } = {},
): Promise<Message> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .for("update");
    if (!draft) throw new Error("Draft not found");
    if (draft.status !== "pending") throw new Error(`Draft is already ${draft.status}`);
    const body = (opts.body ?? draft.body).trim();
    await tx.update(drafts).set({ status: "sent", body }).where(eq(drafts.id, draftId));
    await supersedePendingDrafts(tx, draft.conversationId, draftId);
    return queueOutbound(tx, {
      conversationId: draft.conversationId,
      body,
      source: "ai_approved",
      draftId,
      author: opts.author ?? null,
    });
  });
}

export async function updateDraftBody(db: Database, draftId: string, body: string) {
  const [row] = await db
    .update(drafts)
    .set({ body })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
    .returning();
  if (!row) throw new Error("Draft not found or no longer pending");
  return row;
}

export async function discardDraft(db: Database, draftId: string) {
  const [row] = await db
    .update(drafts)
    .set({ status: "discarded" })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
    .returning();
  if (!row) throw new Error("Draft not found or no longer pending");
  return row;
}

/** Asks the worker to (re)draft a reply now. Manual requests always produce a draft, never an auto-send. */
export async function requestReply(db: Database, conversationId: string) {
  await db
    .update(conversations)
    .set({ pendingReplyAt: new Date(), pendingReplyManual: true })
    .where(eq(conversations.id, conversationId));
}

/** Re-queues a failed outbound message. */
export async function retryMessage(db: Database, messageId: string) {
  const [row] = await db
    .update(messages)
    .set({ status: "queued", error: null })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "failed"),
      ),
    )
    .returning();
  if (!row) throw new Error("Message not found or not failed");
  return row;
}

const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

/** Applies a delivery receipt. Statuses only move forward (sent → delivered → read). */
export async function applyStatusUpdate(
  db: Database,
  update: { waMessageId: string; status: "sent" | "delivered" | "read" | "failed"; error?: string },
) {
  const ranks = (Object.keys(STATUS_RANK) as MessageStatus[]).filter(
    (s) => STATUS_RANK[s] < STATUS_RANK[update.status],
  );
  await db
    .update(messages)
    .set({ status: update.status, ...(update.error ? { error: update.error } : {}) })
    .where(
      and(
        eq(messages.waMessageId, update.waMessageId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ranks),
      ),
    );
}

/**
 * Atomically claims conversations whose reply is due. Safe with several worker
 * processes (SKIP LOCKED), though one worker is the normal setup.
 */
export async function claimDueConversations(
  db: Database,
  limit = 5,
): Promise<Array<{ id: string; manual: boolean }>> {
  const rows = await db.execute<{ id: string; manual: boolean }>(sql`
    UPDATE conversations c
       SET pending_reply_at = NULL, pending_reply_manual = false, reply_generating_at = now()
      FROM (
        SELECT id, pending_reply_manual
          FROM conversations
         WHERE pending_reply_at IS NOT NULL AND pending_reply_at <= now()
         ORDER BY pending_reply_at
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) due
     WHERE c.id = due.id
    RETURNING c.id AS id, due.pending_reply_manual AS manual
  `);
  return Array.from(rows);
}

/** Atomically claims queued outbound messages for sending. */
export async function claimQueuedMessages(db: Database, limit = 10): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE messages m
       SET status = 'sending', updated_at = now()
      FROM (
        SELECT id FROM messages
         WHERE status = 'queued'
         ORDER BY created_at
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) q
     WHERE m.id = q.id
    RETURNING m.id AS id
  `);
  return Array.from(rows, (r) => r.id);
}

/**
 * Messages stuck in 'sending' (worker crashed mid-send) are marked failed
 * rather than re-sent, because they may have gone out. A human can retry.
 */
export async function failStuckSending(db: Database, olderThanSeconds = 120) {
  await db.execute(sql`
    UPDATE messages
       SET status = 'failed',
           error = 'Worker stopped while sending. It may or may not have been delivered; check WhatsApp before retrying.'
     WHERE status = 'sending' AND updated_at < now() - make_interval(secs => ${olderThanSeconds})
  `);
}
