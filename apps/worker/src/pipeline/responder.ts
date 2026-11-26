/**
 * Responder: turns due conversations into Claude drafts, and in auto mode
 * queues them for sending.
 *
 * A conversation is "due" when conversations.pending_reply_at has passed. It is
 * set by inbound messages (with a debounce) and by "Draft a reply" in the UI.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
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
  type Database,
  type Executor,
} from "@phil/core";
import { ClaudeRefusalError, generateReply } from "../ai/claude";
import { log } from "../log";

export async function runResponderTick(db: Database, concurrency: number): Promise<number> {
  const due = await claimDueConversations(db, concurrency);
  await Promise.allSettled(
    due.map(async ({ id, manual }) => {
      try {
        await respond(db, id, manual);
      } catch (err) {
        log.error({ err, conversationId: id }, "Responder failed");
      } finally {
        await db.update(conversations).set({ replyGeneratingAt: null }).where(eq(conversations.id, id));
      }
    }),
  );
  return due.length;
}

async function latestInboundId(db: Executor, conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export async function respond(db: Database, conversationId: string, manual: boolean): Promise<void> {
  const settings = await getSettings(db);
  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, conversationId));
  if (!row) return;
  const { conversation, contact } = row;

  const mode = effectiveMode(conversation, settings);
  if (mode === "off" && !manual) return;

  // Recent history, excluding outbound messages that never went out.
  const recent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), ne(messages.status, "failed")))
    .orderBy(desc(messages.createdAt))
    .limit(settings.historyLimit);
  const history = recent.reverse();
  const last = history[history.length - 1];
  if (!last) return;
  // Someone already replied after the contact's last message.
  if (last.direction === "outbound" && !manual) return;

  const triggerId = await latestInboundId(db, conversationId);
  const knowledge = await db
    .select()
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.enabled, true))
    .orderBy(asc(knowledgeEntries.sortOrder), asc(knowledgeEntries.createdAt));

  const logCtx = { conversationId, mode, manual, contact: contact.waId };
  log.info(logCtx, "Generating reply");

  let result;
  try {
    result = await generateReply({ settings, contact, conversation, history, knowledge, manual });
  } catch (err) {
    const message =
      err instanceof ClaudeRefusalError
        ? err.message
        : err instanceof Anthropic.APIError
          ? `Claude API error${err.status ? ` ${err.status}` : ""}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
    log.error({ ...logCtx, err }, "Reply generation failed");
    await db.transaction(async (tx) => {
      await tx
        .update(drafts)
        .set({ status: "superseded" })
        .where(and(eq(drafts.conversationId, conversationId), eq(drafts.status, "pending")));
      await tx.insert(drafts).values({
        conversationId,
        triggerMessageId: triggerId,
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
    // If the contact wrote again while Claude was thinking, this draft is stale; a newer run is already scheduled.
    const newestInbound = await latestInboundId(tx, conversationId);
    const stale = newestInbound !== triggerId;
    // If a human replied while Claude was thinking, don't auto-send on top of them.
    const [humanAfter] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "outbound"),
          sql`${messages.createdAt} > ${last.createdAt.toISOString()}::timestamptz`,
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
