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
/** A chat is either one person or a WhatsApp group. */
export const contactKindEnum = pgEnum("contact_kind", ["person", "group"]);
/**
 * Where Claude's reply to a group message goes:
 *  - chat:   into the same chat (the group)
 *  - sender: privately, in a 1:1 chat with the member who wrote (created if needed)
 */
export const replyTargetEnum = pgEnum("reply_target", ["chat", "sender"]);

/** Cached member list of a WhatsApp group. */
export interface GroupParticipant {
  /** Same addressing as contacts.wa_id, so a member maps to their person contact. */
  waId: string;
  phone?: string | null;
  name?: string | null;
  admin?: boolean;
}

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Everyone (and every group) the business talks to. A group is stored as a
 * contact of kind 'group' whose wa_id is the group JID and profile_name its subject.
 */
export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: contactKindEnum("kind").notNull().default("person"),
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
  /**
   * Whether messages in this chat are captured. Groups start untracked unless
   * auto-tracked; people can be untracked from the UI ("not a customer").
   */
  tracked: boolean("tracked").notNull().default(true),
  /** Groups only: member list from WhatsApp. */
  participants: jsonb("participants").$type<GroupParticipant[]>(),
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
    /** Groups: where Claude replies (see replyTargetEnum). */
    replyTarget: replyTargetEnum("reply_target").notNull().default("chat"),
    /**
     * 1:1 chats: the group conversation whose message triggered the pending
     * private reply. Gives Claude the group context. Cleared when claimed.
     */
    pendingContextId: uuid("pending_context_id"),
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
    /** Group messages: the member who wrote it. */
    senderContactId: uuid("sender_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** Group messages: the sender's WhatsApp name at the time. */
    senderName: text("sender_name"),
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
    /** Private replies to a group message: the group it was prompted by. */
    contextConversationId: uuid("context_conversation_id"),
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
  /** Start capturing groups the account joins after WhatsApp is linked. */
  autoTrackNewGroups: boolean("auto_track_new_groups").notNull().default(true),
  /** Assistant mode given to newly tracked groups. */
  groupDefaultMode: conversationModeEnum("group_default_mode").notNull().default("auto"),
  /** Where Claude replies for newly tracked groups. */
  groupReplyTarget: replyTargetEnum("group_reply_target").notNull().default("sender"),
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
export type ContactKind = (typeof contactKindEnum.enumValues)[number];
export type ReplyTarget = (typeof replyTargetEnum.enumValues)[number];
export type MessageStatus = (typeof messageStatusEnum.enumValues)[number];
export type MessageSource = (typeof messageSourceEnum.enumValues)[number];
export type DraftAction = (typeof draftActionEnum.enumValues)[number];
