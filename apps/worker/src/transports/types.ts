import type { IncomingMessage, ServerResponse } from "node:http";

export interface InboundEvent {
  /** Contact address for sending replies (phone digits for Cloud API, JID for WhatsApp Web). */
  waId: string;
  phone?: string | null;
  profileName?: string | null;
  waMessageId: string;
  type: string;
  body: string;
  timestamp: Date;
  /**
   * True when the message was sent BY the business account from another
   * device (e.g. the phone). Recorded as an outbound "external" message.
   */
  fromMe?: boolean;
  meta?: Record<string, unknown>;
}

export interface StatusEvent {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error?: string;
}

export type ConnectionState = "starting" | "connecting" | "qr" | "connected" | "disconnected" | "error";

export interface TransportHandlers {
  onMessage(event: InboundEvent): Promise<void>;
  onStatus(event: StatusEvent): Promise<void>;
  onState(state: ConnectionState, info?: { detail?: string; qr?: string | null; account?: string | null }): Promise<void>;
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
