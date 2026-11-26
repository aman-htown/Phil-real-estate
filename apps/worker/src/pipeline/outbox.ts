/**
 * Outbox: sends messages queued by the UI (human replies, approved drafts)
 * and by the responder (auto replies) through the active transport.
 */
import { and, desc, eq } from "drizzle-orm";
import { claimQueuedMessages, contacts, conversations, messages, type Database } from "@phil/core";
import { log } from "../log";
import { PermanentSendError, type Transport } from "../transports";

export async function runOutboxTick(db: Database, transport: Transport, isReady: () => boolean): Promise<number> {
  // While WhatsApp is (re)connecting, leave messages queued instead of failing them.
  if (!isReady()) return 0;
  const ids = await claimQueuedMessages(db, 10);
  // Sequential on purpose: keeps per-chat ordering and is gentle on WhatsApp rate limits.
  for (const id of ids) await sendOne(db, transport, id);
  return ids.length;
}

async function sendOne(db: Database, transport: Transport, messageId: string) {
  const [row] = await db
    .select({ message: messages, contact: contacts })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(messages.id, messageId));
  if (!row) return;
  const { message, contact } = row;
  const target = { waId: contact.waId, phone: contact.phone };

  // Mark the contact's latest message as read when we answer (best effort).
  if (transport.markRead) {
    const [lastInbound] = await db
      .select({ waMessageId: messages.waMessageId, meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.conversationId, message.conversationId), eq(messages.direction, "inbound")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (lastInbound?.waMessageId) {
      await transport
        .markRead(target, lastInbound.waMessageId, lastInbound.meta)
        .catch((err) => log.debug({ err }, "markRead failed"));
    }
  }

  try {
    const { waMessageId } = await transport.sendText(target, message.body);
    // Only move 'sending' → 'sent'; a fast delivery receipt may already have advanced it.
    await db.update(messages).set({ waMessageId, sentAt: new Date() }).where(eq(messages.id, messageId));
    await db
      .update(messages)
      .set({ status: "sent" })
      .where(and(eq(messages.id, messageId), eq(messages.status, "sending")));
    log.info({ messageId, to: contact.waId, source: message.source }, "Message sent");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ messageId, err, permanent: err instanceof PermanentSendError }, "Send failed");
    await db.update(messages).set({ status: "failed", error }).where(eq(messages.id, messageId));
    await db
      .update(conversations)
      .set({ needsAttention: true, attentionReason: `A message failed to send: ${error}` })
      .where(eq(conversations.id, message.conversationId));
  }
}
