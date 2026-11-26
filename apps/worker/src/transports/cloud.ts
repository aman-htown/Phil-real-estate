/**
 * WhatsApp Business Cloud API transport (official, Meta-hosted).
 *
 * Inbound: Meta POSTs webhooks to  {WORKER_URL}/webhooks/whatsapp
 * Outbound: POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *
 * Setup: developers.facebook.com → your app → WhatsApp → Configuration:
 *   Callback URL  = https://<worker-host>/webhooks/whatsapp
 *   Verify token  = WHATSAPP_VERIFY_TOKEN
 *   Subscribe to the "messages" field.
 *
 * Note: free-form replies are only allowed within 24h of the contact's last
 * message. Outside that window WhatsApp requires an approved template, and the
 * send fails with error 131047; the message is marked failed in the UI.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config";
import { log } from "../log";
import {
  PermanentSendError,
  type InboundEvent,
  type SendTarget,
  type Transport,
  type TransportHandlers,
} from "./types";

const WEBHOOK_PATH = "/webhooks/whatsapp";

interface CloudMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string; id: string; mime_type?: string };
  video?: { caption?: string; id: string };
  audio?: { id: string; voice?: boolean };
  document?: { caption?: string; filename?: string; id: string };
  sticker?: { id: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string; description?: string } };
  button?: { text: string; payload?: string };
  reaction?: { emoji?: string; message_id: string };
  context?: { id?: string; from?: string };
}

interface CloudStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  errors?: Array<{ code: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

interface CloudWebhook {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: CloudMessage[];
        statuses?: CloudStatus[];
      };
    }>;
  }>;
}

export function describeCloudMessage(m: CloudMessage): { type: string; body: string } {
  switch (m.type) {
    case "text":
      return { type: "text", body: m.text?.body ?? "" };
    case "image":
      return { type: "image", body: m.image?.caption ?? "" };
    case "video":
      return { type: "video", body: m.video?.caption ?? "" };
    case "audio":
      return { type: "audio", body: "" };
    case "document":
      return { type: "document", body: [m.document?.filename, m.document?.caption].filter(Boolean).join(" — ") };
    case "sticker":
      return { type: "sticker", body: "" };
    case "location": {
      const l = m.location;
      const label = [l?.name, l?.address].filter(Boolean).join(", ");
      return { type: "location", body: `${label ? `${label} ` : ""}(${l?.latitude}, ${l?.longitude})` };
    }
    case "contacts":
      return {
        type: "contacts",
        body: (m.contacts ?? [])
          .map((c) => [c.name?.formatted_name, ...(c.phones ?? []).map((p) => p.phone)].filter(Boolean).join(" "))
          .join("; "),
      };
    case "interactive":
      return {
        type: "text",
        body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "",
      };
    case "button":
      return { type: "text", body: m.button?.text ?? "" };
    case "reaction":
      return { type: "reaction", body: m.reaction?.emoji ?? "" };
    default:
      return { type: "unknown", body: "" };
  }
}

export class CloudTransport implements Transport {
  readonly name = "cloud";
  private handlers?: TransportHandlers;

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    // Validate config eagerly so misconfiguration fails at boot.
    void config.cloud.accessToken;
    void config.cloud.phoneNumberId;
    void config.cloud.verifyToken;
    if (!config.cloud.appSecret) {
      log.warn("WHATSAPP_APP_SECRET not set: webhook signatures will NOT be verified");
    }
    await handlers.onState("connected", {
      detail: `Cloud API, phone number id ${config.cloud.phoneNumberId}. Webhook: ${WEBHOOK_PATH}`,
      account: config.cloud.phoneNumberId,
    });
  }

  async stop(): Promise<void> {}

  private async graph(body: Record<string, unknown>): Promise<any> {
    const url = `https://graph.facebook.com/${config.cloud.graphVersion}/${config.cloud.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.cloud.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const e = json?.error;
      const msg = `WhatsApp API ${res.status}: ${e?.message ?? "unknown error"}${
        e?.error_data?.details ? ` (${e.error_data.details})` : ""
      }${e?.code ? ` [code ${e.code}]` : ""}`;
      // 4xx are request problems (24h window, invalid number, ...) — retrying won't help.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentSendError(msg);
      throw new Error(msg);
    }
    return json;
  }

  async sendText(to: SendTarget, body: string): Promise<{ waMessageId: string }> {
    const json = await this.graph({
      recipient_type: "individual",
      to: to.waId,
      type: "text",
      text: { body, preview_url: true },
    });
    const id = json?.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp API returned no message id");
    return { waMessageId: id };
  }

  async markRead(_to: SendTarget, waMessageId: string): Promise<void> {
    await this.graph({ status: "read", message_id: waMessageId });
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== WEBHOOK_PATH) return false;

    if (req.method === "GET") {
      // Webhook verification handshake.
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === config.cloud.verifyToken && challenge) {
        res.writeHead(200, { "Content-Type": "text/plain" }).end(challenge);
      } else {
        res.writeHead(403).end("Forbidden");
      }
      return true;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return true;
    }

    const raw = await readBody(req);
    if (config.cloud.appSecret && !verifySignature(raw, req.headers["x-hub-signature-256"], config.cloud.appSecret)) {
      log.warn("Rejected webhook with invalid signature");
      res.writeHead(401).end("Invalid signature");
      return true;
    }

    let payload: CloudWebhook;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return true;
    }

    try {
      await this.process(payload);
      res.writeHead(200).end("OK");
    } catch (err) {
      // 500 makes Meta redeliver later; ingestion is idempotent on message id.
      log.error({ err }, "Failed to process webhook");
      res.writeHead(500).end("Error");
    }
    return true;
  }

  private async process(payload: CloudWebhook): Promise<void> {
    if (!this.handlers) throw new Error("Transport not started");
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) continue;
        const value = change.value;
        if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== config.cloud.phoneNumberId) {
          continue; // another number on the same WhatsApp Business Account
        }
        const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

        for (const m of value.messages ?? []) {
          const { type, body } = describeCloudMessage(m);
          const event: InboundEvent = {
            waId: m.from,
            phone: m.from,
            profileName: names.get(m.from) ?? null,
            waMessageId: m.id,
            type,
            body,
            timestamp: new Date(Number(m.timestamp) * 1000),
            meta: {
              cloudType: m.type,
              ...(m.context?.id ? { replyTo: m.context.id } : {}),
              ...(m.image ? { mediaId: m.image.id, mime: m.image.mime_type } : {}),
              ...(m.video ? { mediaId: m.video.id } : {}),
              ...(m.audio ? { mediaId: m.audio.id, voice: m.audio.voice ?? false } : {}),
              ...(m.document ? { mediaId: m.document.id, filename: m.document.filename } : {}),
            },
          };
          await this.handlers.onMessage(event);
        }

        for (const s of value.statuses ?? []) {
          const e = s.errors?.[0];
          await this.handlers.onStatus({
            waMessageId: s.id,
            status: s.status,
            error: e ? `${e.title ?? e.message ?? "Delivery failed"}${e.error_data?.details ? `: ${e.error_data.details}` : ""} [code ${e.code}]` : undefined,
          });
        }
      }
    }
  }
}

function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function verifySignature(raw: Buffer, header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
  const received = Buffer.from(header.slice("sha256=".length), "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
