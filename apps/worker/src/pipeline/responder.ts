/**
 * Responder: turns due conversations into Claude drafts, and in auto mode
 * queues them for sending.
 *
 * A conversation is "due" when conversations.pending_reply_at has passed. It is
 * set by inbound messages (with a debounce), by "Draft with AI" in the UI, and
 * by messages in groups set to reply privately: those schedule the reply on the
 * member's 1:1 conversation and point pending_context_id at the group.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  claimDueConversations,
  contacts,
  conversations,
  drafts,
  effectiveMode,
  getSettings,
  knowledgeEntries,
  messages,
  queueOutbound,
  type Contact,
  type Database,
  type Executor,
  type Message,
} from "@phil/core";
import { ClaudeRefusalError, generateReply } from "../ai/claude";
import type { GroupContext } from "../ai/prompt";
import { log } from "../log";

/** How many group messages Claude sees when replying privately to a member. */
const GROUP_CONTEXT_MESSAGES = 30;

export async function runResponderTick(db: Database, concurrency: number): Promise<number> {
  const due = await claimDueConversations(db, concurrency);
  await Promise.allSettled(
    due.map(async ({ id, manual, contextId }) => {
      try {
        await respond(db, id, manual, contextId);
      } catch (err) {
        log.error({ err, conversationId: id }, "Responder failed");
      } finally {
        await db.update(conversations).set({ replyGeneratingAt: null }).where(eq(conversations.id, id));
      }
    }),
  );
  return due.length;
}

async function latestInbound(db: Executor, conversationId: string, senderContactId?: string): Promise<Message | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "inbound"),
        senderContactId ? eq(messages.senderContactId, senderContactId) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row ?? null;
}

async function recentMessages(db: Executor, conversationId: string, limit: number): Promise<Message[]> {
  // Excludes outbound messages that never went out.
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), ne(messages.status, "failed")))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Group chats: label each message with the member who wrote it ("Dana +15550001234"). */
async function labelSenders(db: Executor, history: Message[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(history.flatMap((m) => (m.senderContactId ? [m.senderContactId] : []))));
  const labels = new Map<string, string>();
  if (!ids.length) return labels;
  const rows = await db.select().from(contacts).where(inArray(contacts.id, ids));
  for (const c of rows) {
    const name = c.displayName || c.profileName;
    labels.set(c.id, [name, c.phone ? `+${c.phone}` : null].filter(Boolean).join(" ") || "Member");
  }
  return labels;
}

function describeError(err: unknown): string {
  if (err instanceof ClaudeRefusalError) return err.message;
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function respond(
  db: Database,
  conversationId: string,
  manual: boolean,
  contextId: string | null = null,
): Promise<void> {
  const settings = await getSettings(db);
  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, conversationId));
  if (!row) return;
  const { conversation, contact } = row;

  // A private reply prompted by this person's message in a group.
  let group: { conversation: typeof conversation; contact: Contact; trigger: Message } | null = null;
  if (contextId && contact.kind === "person") {
    const [g] = await db
      .select({ conversation: conversations, contact: contacts })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, contextId));
    const trigger = g ? await latestInbound(db, g.conversation.id, contact.id) : null;
    if (g && trigger) group = { ...g, trigger };
  }

  // Group-prompted replies follow the group's setting, unless the person's own chat is switched off.
  const mode = group
    ? conversation.mode === "off"
      ? "off"
      : effectiveMode(group.conversation, settings)
    : effectiveMode(conversation, settings);
  if (mode === "off" && !manual) return;

  const history = await recentMessages(db, conversationId, settings.historyLimit);
  const lastInChat = history[history.length - 1];
  const lastInbound = [...history].reverse().find((m) => m.direction === "inbound") ?? null;
  // The newest thing the person said, here or (for group-prompted replies) in the group.
  const latestFromThem =
    group && (!lastInbound || group.trigger.createdAt > lastInbound.createdAt) ? group.trigger : lastInbound;
  const lastOutbound = [...history].reverse().find((m) => m.direction === "outbound") ?? null;

  if (!latestFromThem && !lastInChat) return;
  // Someone already replied after the person's latest message.
  if (!manual && (!latestFromThem || (lastOutbound && lastOutbound.createdAt > latestFromThem.createdAt))) return;

  let groupContext: GroupContext | undefined;
  if (group) {
    const groupHistory = await recentMessages(db, group.conversation.id, GROUP_CONTEXT_MESSAGES);
    groupContext = {
      contact: group.contact,
      history: groupHistory,
      senderLabels: await labelSenders(db, groupHistory),
      trigger: group.trigger,
    };
  }
  const senderLabels = contact.kind === "group" ? await labelSenders(db, history) : undefined;
  const fingerprint = async (ex: Executor) =>
    [
      (await latestInbound(ex, conversationId))?.id ?? "",
      group ? ((await latestInbound(ex, group.conversation.id, contact.id))?.id ?? "") : "",
    ].join("|");
  const before = await fingerprint(db);
  const triggerId = latestFromThem?.id ?? null;

  const knowledge = await db
    .select()
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.enabled, true))
    .orderBy(asc(knowledgeEntries.sortOrder), asc(knowledgeEntries.createdAt));

  const logCtx = { conversationId, mode, manual, contact: contact.waId, fromGroup: group?.conversation.id };
  log.info(logCtx, group ? "Generating private reply to a group message" : "Generating reply");

  let result;
  try {
    result = await generateReply({
      settings,
      contact,
      conversation,
      history,
      senderLabels,
      group: groupContext,
      knowledge,
      manual,
    });
  } catch (err) {
    const message = describeError(err);
    log.error({ ...logCtx, err }, "Reply generation failed");
    await db.transaction(async (tx) => {
      await tx
        .update(drafts)
        .set({ status: "superseded" })
        .where(and(eq(drafts.conversationId, conversationId), eq(drafts.status, "pending")));
      await tx.insert(drafts).values({
        conversationId,
        triggerMessageId: triggerId,
        contextConversationId: group?.conversation.id ?? null,
        status: "error",
        error: message,
        model: settings.model,
      });
      await tx
        .update(conversations)
        .set({ needsAttention: true, attentionReason: `AI could not draft a reply: ${message}` })
        .where(eq(conversations.id, conversationId));
    });
    return;
  }

  const { decision } = result;
  const replyText = decision.reply.trim();

  await db.transaction(async (tx) => {
    // If the person wrote again while Claude was thinking, this draft is stale; a newer run is already scheduled.
    const stale = (await fingerprint(tx)) !== before;
    // If a human replied while Claude was thinking, don't auto-send on top of them.
    const since = latestFromThem?.createdAt ?? lastInChat!.createdAt;
    const [humanAfter] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "outbound"),
          sql`${messages.createdAt} > ${since.toISOString()}::timestamptz`,
        ),
      )
      .limit(1);

    await tx
      .update(drafts)
      .set({ status: "superseded" })
      .where(and(eq(drafts.conversationId, conversationId), eq(drafts.status, "pending")));

    const autoSend =
      !manual &&
      !stale &&
      !humanAfter &&
      mode === "auto" &&
      settings.autoSendEnabled &&
      decision.action === "reply" &&
      replyText.length > 0;

    const status =
      stale || humanAfter
        ? "superseded"
        : decision.action === "no_reply"
          ? "skipped"
          : autoSend
            ? "sent"
            : "pending";

    const [draft] = await tx
      .insert(drafts)
      .values({
        conversationId,
        triggerMessageId: triggerId,
        contextConversationId: group?.conversation.id ?? null,
        status,
        action: decision.action,
        body: replyText,
        originalBody: replyText,
        operatorNote: decision.operator_note,
        intent: decision.intent,
        urgency: decision.urgency,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        latencyMs: result.latencyMs,
      })
      .returning();

    await tx
      .update(conversations)
      .set({
        summary: decision.summary || conversation.summary,
        intent: decision.intent || conversation.intent,
        ...(decision.action === "escalate"
          ? { needsAttention: true, attentionReason: decision.operator_note || "Claude escalated this conversation" }
          : decision.urgency === "high" && status === "pending"
            ? { needsAttention: true, attentionReason: decision.operator_note }
            : {}),
        // A private chat opened for a group message that turned out to need no reply: keep it out of the way.
        ...(group && status === "skipped" && history.length === 0 ? { status: "archived" as const } : {}),
      })
      .where(eq(conversations.id, conversationId));

    if (autoSend && draft) {
      await queueOutbound(tx, {
        conversationId,
        body: replyText,
        source: "ai_auto",
        draftId: draft.id,
      });
    }

    log.info(
      {
        ...logCtx,
        action: decision.action,
        status,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        cacheReadTokens: result.cacheReadTokens,
        outputTokens: result.outputTokens,
      },
      "Reply drafted",
    );
  });
}
