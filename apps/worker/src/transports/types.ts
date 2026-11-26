import type { IncomingMessage, ServerResponse } from "node:http";
import type { GroupInfo, SenderRef } from "@phil/core";

export interface InboundEvent {
  /** Chat address used for replies: the person (phone digits for Cloud API, JID for WhatsApp Web) or the group JID. */
  waId: string;
  isGroup?: boolean;
  phone?: string | null;
  /** Person: their WhatsApp name. Group: the group subject. */
  profileName?: string | null;
  /** Group messages: the member who wrote it. */
  sender?: SenderRef;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  /**
   * True when the message was sent BY the business account from another
   * device (e.g. the phone). Recorded as an outbound "external" message.
   */
  fromMe?: boolean;
  /** Group messages: the business account was @mentioned. */
  mentionsMe?: boolean;
  /** false = store without replying (e.g. a message from days ago delivered after downtime). */
  allowReply?: boolean;
  meta?: Record<string, unknown>;
}

export interface StatusEvent {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error?: string;
}

export type ConnectionState = "starting" | "connecting" | "qr" | "connected" | "disconnected" | "error";

/**
 * How a batch of groups was discovered, which decides whether never-seen
 * groups get tracked automatically:
 *  - baseline: the groups the account was already in when it was linked (never auto-tracked)
 *  - sync:     reconnect; anything unseen was joined while the worker was offline
 *  - live:     the account was just added to the group
 */
export type GroupDiscovery = "baseline" | "sync" | "live";

export interface TransportHandlers {
  onMessage(event: InboundEvent): Promise<void>;
  onStatus(event: StatusEvent): Promise<void>;
  onState(state: ConnectionState, info?: { detail?: string; qr?: string | null; account?: string | null }): Promise<void>;
  /** Group list / metadata changes (WhatsApp Web only). */
  onGroups?(groups: GroupInfo[], discovery: GroupDiscovery): Promise<void>;
  /** Past messages delivered when WhatsApp is linked (WhatsApp Web only). Stored, never replied to. */
  onHistory?(events: InboundEvent[]): Promise<void>;
}

export interface SendTarget {
  waId: string;
  phone?: string | null;
}

export interface Transport {
  readonly name: string;
  start(handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  sendText(to: SendTarget, body: string): Promise<{ waMessageId: string }>;
  /** Best-effort: mark the contact's message as read (blue ticks). */
  markRead?(to: SendTarget, waMessageId: string, meta?: Record<string, unknown> | null): Promise<void>;
  /** Lets a transport serve HTTP routes (e.g. the Cloud API webhook). Return true if handled. */
  handleHttp?(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

/** Thrown for send failures that should not be retried automatically. */
export class PermanentSendError extends Error {}
