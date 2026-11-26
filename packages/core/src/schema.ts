import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * How the assistant behaves in a conversation.
 *  - auto:  Claude's reply is sent immediately.
 *  - draft: Claude writes a draft; a human approves/edits it in the web UI.
 *  - off:   Claude stays silent; humans handle it.
 * A conversation with mode = null inherits `app_settings.default_mode`.
 */
export const conversationModeEnum = pgEnum("conversation_mode", ["auto", "draft", "off"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "archived"]);
export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);
/**
 * received: inbound message stored
 * queued:   outbound message waiting for the worker's outbox
 * sending:  claimed by the worker, in flight
 * sent / delivered / read: WhatsApp delivery receipts
 * failed:   could not be sent (see `error`)
 */
export const messageStatusEnum = pgEnum("message_status", [
  "received",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
]);
/**
 * Who produced a message.
 *  contact:     the person on the other end
 *  ai_auto:     Claude, sent automatically (auto mode)
 *  ai_approved: Claude's draft, approved (and possibly edited) by a human in the UI
 *  human:       typed by a human in the web UI
 *  external:    sent from the WhatsApp account directly (e.g. from the phone),
 *               observed by the worker
 */
export const messageSourceEnum = pgEnum("message_source", [
  "contact",
  "ai_auto",
  "ai_approved",
  "human",
  "external",
]);
export const draftStatusEnum = pgEnum("draft_status", [
  "pending", // waiting for a human
  "sent", // turned into an outbound message
  "discarded", // a human threw it away
  "superseded", // a newer draft or a human reply replaced it
  "skipped", // Claude decided no reply was needed
  "error", // generation failed
]);
export const draftActionEnum = pgEnum("draft_action", ["reply", "no_reply", "escalate"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Transport-level address: phone digits for the Cloud API, a JID for WhatsApp Web. */
  waId: text("wa_id").notNull().unique(),
  /** E.164-ish phone number without '+', when known. */
  phone: text("phone"),
  /** Name WhatsApp reports for the contact (their profile name). */
  profileName: text("profile_name"),
  /** Name set by a human in the UI. Takes precedence over profileName. */
  displayName: text("display_name"),
  /** Free-form notes. Fed to Claude as context. */
  notes: text("notes").notNull().default(""),
  tags: text("tags")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  ...timestamps,
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .unique()
      .references(() => contacts.id, { onDelete: "cascade" }),
    mode: conversationModeEnum("mode"),
    status: conversationStatusEnum("status").notNull().default("open"),
    needsAttention: boolean("needs_attention").notNull().default(false),
    attentionReason: text("attention_reason"),
    /** Rolling summary maintained by Claude. */
    summary: text("summary"),
    /** Claude's short label for what the contact wants (e.g. "viewing request"). */
    intent: text("intent"),
    unreadCount: integer("unread_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: text("last_message_preview"),
    /** Last time the contact wrote. The Cloud API only allows free-form replies within 24h of it. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    /**
     * Job marker for the responder. When set, the worker generates a reply once
     * this time passes. Each new inbound message pushes it forward (debounce), so
     * a contact typing several messages in a row gets one reply.
     */
    pendingReplyAt: timestamp("pending_reply_at", { withTimezone: true }),
    /** Set when a human explicitly asked for a (re)draft. Forces draft mode for that run. */
    pendingReplyManual: boolean("pending_reply_manual").notNull().default(false),
    /** Set while the worker is generating a reply, so the UI can show "drafting…". */
    replyGeneratingAt: timestamp("reply_generating_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("conversations_last_message_at_idx").on(t.lastMessageAt),
    index("conversations_pending_reply_at_idx")
      .on(t.pendingReplyAt)
      .where(sql`${t.pendingReplyAt} IS NOT NULL`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    source: messageSourceEnum("source").notNull(),
    status: messageStatusEnum("status").notNull(),
    /** text | image | audio | video | document | sticker | location | contacts | reaction | unknown */
    type: text("type").notNull().default("text"),
    body: text("body").notNull().default(""),
    /** Extra transport data (media ids, captions, raw payload snippets). */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    /** WhatsApp's message id. Unique so redelivered webhooks are ignored. */
    waMessageId: text("wa_message_id").unique(),
    error: text("error"),
    draftId: uuid("draft_id"),
    /** Label of the UI user who sent / approved it. */
    author: text("author"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    index("messages_outbox_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The latest inbound message the draft responds to. */
    triggerMessageId: uuid("trigger_message_id"),
    status: draftStatusEnum("status").notNull().default("pending"),
    action: draftActionEnum("action"),
    /** Current (possibly human-edited) text. */
    body: text("body").notNull().default(""),
    /** Claude's original text, kept so edits can be reviewed later. */
    originalBody: text("original_body").notNull().default(""),
    /** Claude's note to the operator: why it replied this way, what to check. */
    operatorNote: text("operator_note"),
    intent: text("intent"),
    urgency: text("urgency"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("drafts_conversation_idx").on(t.conversationId, t.createdAt)],
);

/** Reference material Claude can draw on: listings, FAQs, policies, fees, areas covered. */
export const knowledgeEntries = pgTable("knowledge_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

/** Single-row table (id = 1) holding everything editable on the Settings page. */
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  businessName: text("business_name").notNull(),
  /** Business-specific instructions: persona, tone, what to offer, what never to say. */
  systemPrompt: text("system_prompt").notNull(),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  defaultMode: conversationModeEnum("default_mode").notNull(),
  /** Global kill switch. When false, auto mode behaves like draft mode everywhere. */
  autoSendEnabled: boolean("auto_send_enabled").notNull(),
  /** Seconds to wait after the latest inbound message before replying. */
  debounceSeconds: integer("debounce_seconds").notNull(),
  /** How many recent messages to give Claude. */
  historyLimit: integer("history_limit").notNull(),
  /** IANA time zone used for timestamps shown to Claude (e.g. "America/New_York"). */
  timezone: text("timezone").notNull().default("UTC"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Heartbeat + connection state the worker publishes for the Status page. */
export const workerStatus = pgTable("worker_status", {
  id: text("id").primaryKey(),
  transport: text("transport").notNull(),
  /** starting | connecting | qr | connected | disconnected | error */
  state: text("state").notNull(),
  detail: text("detail"),
  /** WhatsApp Web pairing QR payload, rendered by the UI while state = 'qr'. */
  qr: text("qr"),
  account: text("account"),
  version: text("version"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Key/value store for WhatsApp Web (Baileys) session credentials, so the worker survives redeploys. */
export const waAuthState = pgTable("wa_auth_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Contact = typeof contacts.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type WorkerStatus = typeof workerStatus.$inferSelect;
export type ConversationMode = (typeof conversationModeEnum.enumValues)[number];
export type MessageStatus = (typeof messageStatusEnum.enumValues)[number];
export type MessageSource = (typeof messageSourceEnum.enumValues)[number];
export type DraftAction = (typeof draftActionEnum.enumValues)[number];
