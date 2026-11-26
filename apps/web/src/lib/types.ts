import type {
  AppSettings,
  Contact,
  Conversation,
  ConversationMode,
  Draft,
  KnowledgeEntry,
  Message,
  WorkerStatus,
} from "@phil/core";

/** What a value looks like after JSON serialization (Dates become strings). */
export type Jsonify<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type ConversationListItem = Jsonify<
  Pick<
    Conversation,
    | "id"
    | "mode"
    | "status"
    | "needsAttention"
    | "attentionReason"
    | "unreadCount"
    | "lastMessageAt"
    | "lastMessagePreview"
    | "intent"
  > & {
    effectiveMode: ConversationMode;
    hasPendingDraft: boolean;
    generating: boolean;
    contact: Pick<Contact, "id" | "waId" | "phone" | "displayName" | "profileName">;
  }
>;

export type ConversationDetail = Jsonify<{
  conversation: Conversation;
  contact: Contact;
  messages: Message[];
  latestDraft: Draft | null;
  effectiveMode: ConversationMode;
  defaultMode: ConversationMode;
  generating: boolean;
  transport: string | null;
}>;

export type SettingsDTO = Jsonify<AppSettings>;
export type KnowledgeDTO = Jsonify<KnowledgeEntry>;

export type StatusDTO = Jsonify<{
  worker: WorkerStatus | null;
  online: boolean;
  qrDataUrl: string | null;
  stats: {
    conversations: number;
    needsAttention: number;
    pendingDrafts: number;
    messagesToday: number;
    aiDrafts24h: number;
    avgLatencyMs24h: number | null;
    inputTokens24h: number;
    outputTokens24h: number;
  };
}>;

export function contactLabel(c: { displayName?: string | null; profileName?: string | null; phone?: string | null; waId: string }) {
  return c.displayName || c.profileName || (c.phone ? `+${c.phone}` : c.waId.split("@")[0]);
}
