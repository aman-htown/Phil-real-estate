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
    contact: Pick<Contact, "id" | "kind" | "waId" | "phone" | "displayName" | "profileName">;
  }
>;

export type MessageSender = Pick<Contact, "id" | "displayName" | "profileName" | "phone">;

/** A group member, linked to their contact and private conversation when known. */
export interface ParticipantDTO {
  waId: string;
  phone: string | null;
  name: string | null;
  admin: boolean;
  contactId: string | null;
  conversationId: string | null;
}

export interface SharedGroupDTO {
  contactId: string;
  name: string | null;
  conversationId: string | null;
}

export type ConversationDetail = Jsonify<{
  conversation: Conversation;
  contact: Contact;
  messages: Array<Message & { sender: MessageSender | null }>;
  /** Groups: members (excluding the business account). */
  participants: ParticipantDTO[];
  /** People: tracked groups they're in. */
  groups: SharedGroupDTO[];
  /** When the latest draft was prompted by this person's message in a group. */
  draftContext: { conversationId: string; name: string | null } | null;
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

export interface GroupsDTO {
  groups: Array<{
    contactId: string;
    waId: string;
    name: string | null;
    tracked: boolean;
    members: number;
    conversationId: string | null;
    lastMessageAt: string | null;
  }>;
  untrackedPeople: Array<{ contactId: string; waId: string; name: string | null; phone: string | null }>;
  transport: string | null;
}
