/**
 * Capturing chats: people and WhatsApp groups, live messages and history.
 *
 * Tracking rules:
 *  - People are tracked by default. Untracking one ("not a customer") deletes
 *    their stored conversation and stops capture.
 *  - Groups are untracked unless auto-tracked (a group joined after WhatsApp
 *    was linked, when `autoTrackNewGroups` is on) or tracked from the UI.
 *    Messages from untracked chats are never stored.
 *  - New group conversations get the "group defaults" from settings (assistant
 *    mode, and whether Claude replies in the group or privately to the sender).
 *
 * Private replies: when a tracked group is set to reply to the sender, a
 * member's message schedules a reply in that member's 1:1 chat (created if
 * needed) and points it at the group for context (pending_context_id).
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { preview, supersedePendingDrafts, type Executor } from "./ops";
import {
  contacts,
  conversations,
  messages,
  type AppSettings,
  type Contact,
  type ContactKind,
  type Conversation,
  type GroupParticipant,
} from "./schema";
import { effectiveMode, getSettings } from "./settings";

export interface ChatRef {
  /** Person: their address. Group: the group JID. */
  waId: string;
  kind?: ContactKind;
  phone?: string | null;
  /** Person: their WhatsApp profile name. Group: its subject. */
  name?: string | null;
}

export interface SenderRef {
  waId: string;
  phone?: string | null;
  name?: string | null;
}

/** Contact address for a phone number, in the form the active transport uses. */
export function waIdForPhone(transport: string | null | undefined, digits: string): string {
  return transport === "web" ? `${digits}@s.whatsapp.net` : digits;
}

async function resolveChat(tx: Executor, chat: ChatRef, trackIfNew: boolean): Promise<Contact> {
  const kind = chat.kind ?? "person";
  const [contact] = await tx
    .insert(contacts)
    .values({
      waId: chat.waId,
      kind,
      phone: chat.phone ?? null,
      profileName: chat.name ?? null,
      tracked: kind === "group" ? trackIfNew : true,
      participants: kind === "group" ? [] : null,
    })
    .onConflictDoUpdate({
      target: contacts.waId,
      set: {
        phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
        profileName: sql`coalesce(excluded.profile_name, ${contacts.profileName})`,
      },
    })
    .returning();
  if (!contact) throw new Error("contact upsert failed");
  return contact;
}

/** Private replies to group members go out this soon at most, whatever the chat debounce. */
export const GROUP_PRIVATE_REPLY_MAX_DELAY_SECONDS = 5;

type GroupDefaults = Pick<AppSettings, "groupDefaultMode" | "groupReplyTarget">;

async function ensureConversationFor(
  tx: Executor,
  contact: Pick<Contact, "id" | "kind">,
  opts: { reopen: boolean; groupDefaults: GroupDefaults },
): Promise<Conversation> {
  const isGroup = contact.kind === "group";
  const [conversation] = await tx
    .insert(conversations)
    .values({
      contactId: contact.id,
      mode: isGroup ? opts.groupDefaults.groupDefaultMode : null,
      replyTarget: isGroup ? opts.groupDefaults.groupReplyTarget : "chat",
    })
    .onConflictDoUpdate({
      target: conversations.contactId,
      set: opts.reopen ? { status: "open" } : { contactId: sql`excluded.contact_id` },
    })
    .returning();
  if (!conversation) throw new Error("conversation upsert failed");
  return conversation;
}

async function upsertSenders(tx: Executor, senders: SenderRef[]): Promise<Map<string, string>> {
  const unique = new Map<string, SenderRef>();
  for (const s of senders) {
    const prev = unique.get(s.waId);
    unique.set(s.waId, { waId: s.waId, phone: s.phone ?? prev?.phone ?? null, name: s.name ?? prev?.name ?? null });
  }
  if (!unique.size) return new Map();
  const rows = await tx
    .insert(contacts)
    .values(
      Array.from(unique.values(), (s) => ({ waId: s.waId, kind: "person" as const, phone: s.phone ?? null, profileName: s.name ?? null })),
    )
    .onConflictDoUpdate({
      target: contacts.waId,
      set: {
        phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
        profileName: sql`coalesce(excluded.profile_name, ${contacts.profileName})`,
      },
    })
    .returning({ id: contacts.id, waId: contacts.waId });
  return new Map(rows.map((r) => [r.waId, r.id]));
}

/** Adds members we see writing in a group to its cached member list. */
async function addParticipants(tx: Executor, groupId: string, senders: SenderRef[]) {
  for (const s of senders) {
    const entry: GroupParticipant = { waId: s.waId, phone: s.phone ?? null, name: s.name ?? null };
    await tx
      .update(contacts)
      .set({ participants: sql`coalesce(${contacts.participants}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb` })
      .where(
        and(
          eq(contacts.id, groupId),
          sql`not coalesce(${contacts.participants}, '[]'::jsonb) @> ${JSON.stringify([{ waId: s.waId }])}::jsonb`,
        ),
      );
  }
}

/** SET fragment that advances last-message fields only if `ts` is the newest message so far. */
function lastMessageSet(ts: Date, previewText: string) {
  const t = sql`${ts.toISOString()}::timestamptz`;
  return {
    lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${t})`,
    lastMessagePreview: sql`case when ${conversations.lastMessageAt} is null or ${t} >= ${conversations.lastMessageAt} then ${previewText} else ${conversations.lastMessagePreview} end`,
  };
}

function previewFor(input: { type: string; body: string }, senderName?: string | null) {
  return preview(`${senderName ? `${senderName}: ` : ""}${input.body || `[${input.type}]`}`);
}

export interface InboundInput {
  chat: ChatRef;
  /** Group messages: who wrote it. */
  sender?: SenderRef;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
  /** false = store it but don't schedule an AI reply (e.g. stale backlog after downtime). */
  allowReply?: boolean;
  /** For a group seen for the first time: capture it? Defaults to the autoTrackNewGroups setting. */
  trackIfNew?: boolean;
  /** The business account was @mentioned (groups). Flags the conversation. */
  mentionsMe?: boolean;
}

export interface IngestResult {
  duplicate: boolean;
  /** The chat is untracked; nothing was stored. */
  ignored?: boolean;
  conversationId?: string;
  messageId?: string;
  /** Group message that scheduled a private reply: the member's 1:1 conversation. */
  privateConversationId?: string;
}

/**
 * Stores a message from a contact (or a group member) and schedules a reply.
 * Idempotent on `waMessageId`, so webhook redeliveries are harmless.
 */
export async function ingestInbound(db: Database, input: InboundInput): Promise<IngestResult> {
  const settings = await getSettings(db);
  const isGroup = input.chat.kind === "group";
  return db.transaction(async (tx) => {
    const contact = await resolveChat(tx, input.chat, input.trackIfNew ?? settings.autoTrackNewGroups);
    if (!contact.tracked) return { duplicate: false, ignored: true };
    const conversation = await ensureConversationFor(tx, contact, { reopen: true, groupDefaults: settings });

    let senderContactId: string | null = null;
    if (isGroup && input.sender) {
      senderContactId = (await upsertSenders(tx, [input.sender])).get(input.sender.waId) ?? null;
      await addParticipants(tx, contact.id, [input.sender]);
    }

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
        senderContactId,
        senderName: isGroup ? (input.sender?.name ?? null) : null,
        createdAt: input.timestamp,
        sentAt: input.timestamp,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning();
    if (!message) return { duplicate: true, conversationId: conversation.id };

    const mode = effectiveMode(conversation, settings);
    const canReply = input.allowReply !== false && mode !== "off" && input.type !== "reaction";
    const replyPrivately = isGroup && conversation.replyTarget === "sender";
    const scheduleReply = canReply && !replyPrivately;
    const senderLabel = isGroup ? (input.sender?.name ?? input.sender?.phone ?? "Someone") : null;
    await tx
      .update(conversations)
      .set({
        ...lastMessageSet(input.timestamp, previewFor(input, senderLabel)),
        lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${input.timestamp.toISOString()}::timestamptz)`,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        // Debounce: every new message pushes the reply back.
        ...(scheduleReply ? { pendingReplyAt: new Date(Date.now() + settings.debounceSeconds * 1000) } : {}),
        ...(input.mentionsMe
          ? { needsAttention: true, attentionReason: `${senderLabel ?? "Someone"} mentioned you: “${preview(input.body, 80)}”` }
          : {}),
      })
      .where(eq(conversations.id, conversation.id));

    // Group set to reply privately: schedule the reply in the member's 1:1 chat.
    let privateConversationId: string | undefined;
    if (canReply && replyPrivately && senderContactId) {
      const [member] = await tx.select().from(contacts).where(eq(contacts.id, senderContactId));
      if (member?.tracked) {
        const dm = await ensureConversationFor(tx, member, { reopen: true, groupDefaults: settings });
        if (dm.mode !== "off") {
          const delay = Math.min(settings.debounceSeconds, GROUP_PRIVATE_REPLY_MAX_DELAY_SECONDS);
          await tx
            .update(conversations)
            .set({ pendingReplyAt: new Date(Date.now() + delay * 1000), pendingContextId: conversation.id })
            .where(eq(conversations.id, dm.id));
          privateConversationId = dm.id;
        }
      }
    }

    return { duplicate: false, conversationId: conversation.id, messageId: message.id, privateConversationId };
  });
}

export interface ExternalOutboundInput {
  chat: ChatRef;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
  trackIfNew?: boolean;
}

/**
 * Records a message the business account sent from outside this system (e.g.
 * typed on the phone while the worker is linked via WhatsApp Web). A human has
 * replied, so any pending AI reply is cancelled.
 */
export async function recordExternalOutbound(db: Database, input: ExternalOutboundInput): Promise<IngestResult> {
  const settings = await getSettings(db);
  return db.transaction(async (tx) => {
    // Our own sends can echo back; skip anything we already know about.
    const [existing] = await tx
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.waMessageId, input.waMessageId));
    if (existing) return { duplicate: true, conversationId: existing.conversationId };

    const contact = await resolveChat(tx, input.chat, input.trackIfNew ?? settings.autoTrackNewGroups);
    if (!contact.tracked) return { duplicate: false, ignored: true };
    const conversation = await ensureConversationFor(tx, contact, { reopen: false, groupDefaults: settings });
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
        ...lastMessageSet(input.timestamp, previewFor(input, contact.kind === "group" ? "You" : null)),
        pendingReplyAt: null,
        pendingReplyManual: false,
        pendingContextId: null,
        unreadCount: 0,
      })
      .where(eq(conversations.id, conversation.id));
    await supersedePendingDrafts(tx, conversation.id);
    return { duplicate: false, conversationId: conversation.id, messageId: message.id };
  });
}

export interface HistoryItem {
  chat: ChatRef;
  sender?: SenderRef;
  /** Sent by the business account. */
  fromMe: boolean;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

/**
 * Bulk-imports past messages (WhatsApp Web history sync). Stores them for the
 * record only: no replies scheduled, no unread counts, conversations stay as
 * they are. Groups that aren't tracked are skipped. Idempotent.
 */
export async function importHistory(
  db: Database,
  items: HistoryItem[],
): Promise<{ imported: number; chats: number; skippedChats: number }> {
  const settings = await getSettings(db);
  const byChat = new Map<string, HistoryItem[]>();
  for (const item of items) {
    const list = byChat.get(item.chat.waId) ?? [];
    list.push(item);
    byChat.set(item.chat.waId, list);
  }

  let imported = 0;
  let chats = 0;
  let skippedChats = 0;
  for (const list of byChat.values()) {
    const first = list[0]!;
    // Use the most informative chat details in the batch (e.g. a name).
    const chat: ChatRef = { ...first.chat, name: list.find((i) => i.chat.name)?.chat.name ?? null };
    const result = await db.transaction(async (tx) => {
      const contact = await resolveChat(tx, chat, false);
      if (!contact.tracked) return null;
      const conversation = await ensureConversationFor(tx, contact, { reopen: false, groupDefaults: settings });
      const isGroup = contact.kind === "group";

      const senders = isGroup ? list.flatMap((i) => (i.sender && !i.fromMe ? [i.sender] : [])) : [];
      const senderIds = await upsertSenders(tx, senders);
      if (isGroup) {
        const seen = new Set<string>();
        await addParticipants(tx, contact.id, senders.filter((s) => !seen.has(s.waId) && seen.add(s.waId)));
      }

      const unique = Array.from(new Map(list.map((i) => [i.waMessageId, i])).values());
      let inserted = 0;
      for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500);
        const rows = await tx
          .insert(messages)
          .values(
            chunk.map((m) => ({
              conversationId: conversation.id,
              direction: m.fromMe ? ("outbound" as const) : ("inbound" as const),
              source: m.fromMe ? ("external" as const) : ("contact" as const),
              status: m.fromMe ? ("sent" as const) : ("received" as const),
              type: m.type,
              body: m.body,
              meta: { ...(m.meta ?? {}), history: true },
              waMessageId: m.waMessageId,
              senderContactId: !m.fromMe && m.sender ? (senderIds.get(m.sender.waId) ?? null) : null,
              senderName: isGroup && !m.fromMe ? (m.sender?.name ?? null) : null,
              createdAt: m.timestamp,
              sentAt: m.timestamp,
            })),
          )
          .onConflictDoNothing({ target: messages.waMessageId })
          .returning({ id: messages.id });
        inserted += rows.length;
      }

      const newest = unique.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
      const newestInbound = unique.filter((m) => !m.fromMe).reduce<HistoryItem | null>(
        (a, b) => (!a || b.timestamp > a.timestamp ? b : a),
        null,
      );
      const label = isGroup ? (newest.fromMe ? "You" : (newest.sender?.name ?? newest.sender?.phone ?? null)) : null;
      await tx
        .update(conversations)
        .set({
          ...lastMessageSet(newest.timestamp, previewFor(newest, label)),
          ...(newestInbound
            ? { lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${newestInbound.timestamp.toISOString()}::timestamptz)` }
            : {}),
        })
        .where(eq(conversations.id, conversation.id));
      return inserted;
    });
    if (result === null) skippedChats += 1;
    else {
      chats += 1;
      imported += result;
    }
  }
  return { imported, chats, skippedChats };
}

export interface GroupInfo {
  waId: string;
  subject?: string | null;
  participants?: GroupParticipant[];
}

/**
 * Records the groups the account belongs to (for the Groups page). Groups seen
 * for the first time are tracked when `trackIfNew` is true. Tracked groups get
 * a conversation right away so they show up in the inbox.
 */
export async function upsertGroups(db: Database, groups: GroupInfo[], opts: { trackIfNew: boolean }) {
  if (!groups.length) return;
  const settings = await getSettings(db);
  for (const g of groups) {
    await db
      .insert(contacts)
      .values({
        waId: g.waId,
        kind: "group",
        profileName: g.subject ?? null,
        participants: g.participants ?? [],
        tracked: opts.trackIfNew,
      })
      .onConflictDoUpdate({
        target: contacts.waId,
        set: {
          kind: "group",
          profileName: sql`coalesce(excluded.profile_name, ${contacts.profileName})`,
          ...(g.participants ? { participants: sql`excluded.participants` } : {}),
        },
      });
  }
  await db.execute(sql`
    insert into conversations (contact_id, mode, reply_target)
    select c.id, ${settings.groupDefaultMode}::conversation_mode, ${settings.groupReplyTarget}::reply_target from contacts c
     where c.kind = 'group' and c.tracked
       and not exists (select 1 from conversations v where v.contact_id = c.id)
    on conflict (contact_id) do nothing
  `);
}

/**
 * Turns capture on or off for a chat. Turning it off DELETES the stored
 * conversation (messages and drafts) and ignores future messages.
 */
export async function setTracked(db: Database, contactId: string, tracked: boolean): Promise<{ conversationId: string | null }> {
  const settings = await getSettings(db);
  return db.transaction(async (tx) => {
    const [contact] = await tx.update(contacts).set({ tracked }).where(eq(contacts.id, contactId)).returning();
    if (!contact) throw new Error("Contact not found");
    if (!tracked) {
      await tx.delete(conversations).where(eq(conversations.contactId, contactId));
      return { conversationId: null };
    }
    const conversation = await ensureConversationFor(tx, contact, { reopen: true, groupDefaults: settings });
    return { conversationId: conversation.id };
  });
}

/** Opens (or creates) the 1:1 conversation with a contact, e.g. to message a group member privately. */
export async function openConversation(db: Database, contactId: string): Promise<string> {
  const settings = await getSettings(db);
  return db.transaction(async (tx) => {
    const [contact] = await tx.update(contacts).set({ tracked: true }).where(eq(contacts.id, contactId)).returning();
    if (!contact) throw new Error("Contact not found");
    return (await ensureConversationFor(tx, contact, { reopen: true, groupDefaults: settings })).id;
  });
}

/** Starts a conversation with a phone number that hasn't written in yet. */
export async function startConversation(
  db: Database,
  input: { waId: string; phone: string; name?: string | null },
): Promise<string> {
  const settings = await getSettings(db);
  return db.transaction(async (tx) => {
    const contact = await resolveChat(tx, { waId: input.waId, phone: input.phone, kind: "person" }, true);
    const [updated] = await tx
      .update(contacts)
      .set({ tracked: true, ...(input.name && !contact.displayName ? { displayName: input.name } : {}) })
      .where(eq(contacts.id, contact.id))
      .returning();
    return (await ensureConversationFor(tx, updated ?? contact, { reopen: true, groupDefaults: settings })).id;
  });
}
