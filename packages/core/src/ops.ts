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
import { conversations, drafts, messages, type Message, type MessageSource, type MessageStatus } from "./schema";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** A database handle or an open transaction. */
export type Executor = Database | Tx;

export function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function supersedePendingDrafts(tx: Executor, conversationId: string, exceptId?: string) {
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
      ...(input.source === "human" ? { pendingReplyAt: null, pendingReplyManual: false, pendingContextId: null } : {}),
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
): Promise<Array<{ id: string; manual: boolean; contextId: string | null }>> {
  const rows = await db.execute<{ id: string; manual: boolean; contextId: string | null }>(sql`
    UPDATE conversations c
       SET pending_reply_at = NULL, pending_reply_manual = false, pending_context_id = NULL, reply_generating_at = now()
      FROM (
        SELECT id, pending_reply_manual, pending_context_id
          FROM conversations
         WHERE pending_reply_at IS NOT NULL AND pending_reply_at <= now()
         ORDER BY pending_reply_at
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) due
     WHERE c.id = due.id
    RETURNING c.id AS id, due.pending_reply_manual AS manual, due.pending_context_id AS "contextId"
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
