import "server-only";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  contacts,
  conversations,
  drafts,
  effectiveMode,
  getSettings,
  messages,
  workerStatus,
  type Database,
} from "@phil/core";
import type { ConversationDetail, ConversationListItem, Jsonify } from "./types";

export const LIST_FILTERS = ["open", "attention", "drafts", "archived", "all"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

function isGenerating(conv: { pendingReplyAt: Date | null; replyGeneratingAt: Date | null }) {
  const now = Date.now();
  return Boolean(
    conv.pendingReplyAt || (conv.replyGeneratingAt && now - conv.replyGeneratingAt.getTime() < 3 * 60_000),
  );
}

export async function listConversations(db: Database, filter: ListFilter, q: string): Promise<ConversationListItem[]> {
  const settings = await getSettings(db);
  const pendingDraft = sql<boolean>`exists (select 1 from ${drafts} d where d.conversation_id = ${conversations.id} and d.status = 'pending')`;

  const where: SQL[] = [];
  if (filter === "open") where.push(eq(conversations.status, "open"));
  if (filter === "archived") where.push(eq(conversations.status, "archived"));
  if (filter === "attention") where.push(eq(conversations.needsAttention, true));
  if (filter === "drafts") where.push(pendingDraft);
  const term = q.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(
      or(
        ilike(contacts.displayName, like),
        ilike(contacts.profileName, like),
        ilike(contacts.phone, like),
        ilike(contacts.waId, like),
        sql`exists (select 1 from ${messages} m where m.conversation_id = ${conversations.id} and m.body ilike ${like})`,
      )!,
    );
  }

  const rows = await db
    .select({ conversation: conversations, contact: contacts, hasPendingDraft: pendingDraft })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(300);

  return rows.map(({ conversation: c, contact, hasPendingDraft }) => ({
    id: c.id,
    mode: c.mode,
    status: c.status,
    needsAttention: c.needsAttention,
    attentionReason: c.attentionReason,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
    intent: c.intent,
    effectiveMode: effectiveMode(c, settings),
    hasPendingDraft: Boolean(hasPendingDraft),
    generating: isGenerating(c),
    contact: {
      id: contact.id,
      waId: contact.waId,
      phone: contact.phone,
      displayName: contact.displayName,
      profileName: contact.profileName,
    },
  }));
}

export async function getConversationDetail(db: Database, id: string): Promise<ConversationDetail | null> {
  const settings = await getSettings(db);
  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, id));
  if (!row) return null;

  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(desc(messages.createdAt))
    .limit(300);
  const [latestDraft] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.conversationId, id))
    .orderBy(desc(drafts.createdAt))
    .limit(1);
  const [worker] = await db.select({ transport: workerStatus.transport }).from(workerStatus).orderBy(asc(workerStatus.id)).limit(1);

  const detail = {
    conversation: row.conversation,
    contact: row.contact,
    messages: recent.reverse(),
    latestDraft: latestDraft ?? null,
    effectiveMode: effectiveMode(row.conversation, settings),
    defaultMode: settings.defaultMode,
    generating: isGenerating(row.conversation),
    transport: worker?.transport ?? null,
  };
  // Round-trip through JSON so the declared DTO type matches what the client receives.
  return JSON.parse(JSON.stringify(detail)) as Jsonify<typeof detail>;
}
