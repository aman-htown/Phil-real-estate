/**
 * WhatsApp Web transport (Baileys). Links the worker to an existing WhatsApp
 * or WhatsApp Business app account as a "linked device", the same way
 * web.whatsapp.com does. Pair by scanning the QR code shown on the web UI's
 * Status page (or printed in the worker logs).
 *
 * Use this to observe an inbox that is also used from a phone. Messages typed
 * on the phone show up in the UI as "sent from phone" and cancel pending AI
 * replies.
 *
 * Caveat: this is an unofficial client. WhatsApp may ban numbers that behave
 * like bots. For a dedicated business number, prefer the Cloud API transport.
 */
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
  type proto,
} from "baileys";
import { eq } from "drizzle-orm";
import { getDb, messages } from "@phil/core";
import { config } from "../config";
import { log } from "../log";
import type { SendTarget, Transport, TransportHandlers } from "./types";
import { usePostgresAuthState } from "./web-auth";

export function describeWebMessage(content: proto.IMessage | null | undefined): { type: string; body: string } | null {
  const msg = normalizeMessageContent(content);
  if (!msg) return null;
  const kind = getContentType(msg);
  switch (kind) {
    case "conversation":
      return { type: "text", body: msg.conversation ?? "" };
    case "extendedTextMessage":
      return { type: "text", body: msg.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return { type: "image", body: msg.imageMessage?.caption ?? "" };
    case "videoMessage":
      return { type: "video", body: msg.videoMessage?.caption ?? "" };
    case "audioMessage":
      return { type: "audio", body: "" };
    case "documentMessage":
      return {
        type: "document",
        body: [msg.documentMessage?.fileName, msg.documentMessage?.caption].filter(Boolean).join(" — "),
      };
    case "documentWithCaptionMessage":
      return describeWebMessage(msg.documentWithCaptionMessage?.message);
    case "stickerMessage":
      return { type: "sticker", body: "" };
    case "locationMessage": {
      const l = msg.locationMessage;
      const label = [l?.name, l?.address].filter(Boolean).join(", ");
      return { type: "location", body: `${label ? `${label} ` : ""}(${l?.degreesLatitude}, ${l?.degreesLongitude})` };
    }
    case "contactMessage":
      return { type: "contacts", body: msg.contactMessage?.displayName ?? "" };
    case "buttonsResponseMessage":
      return { type: "text", body: msg.buttonsResponseMessage?.selectedDisplayText ?? "" };
    case "listResponseMessage":
      return { type: "text", body: msg.listResponseMessage?.title ?? "" };
    case "templateButtonReplyMessage":
      return { type: "text", body: msg.templateButtonReplyMessage?.selectedDisplayText ?? "" };
    case "reactionMessage":
      return { type: "reaction", body: msg.reactionMessage?.text ?? "" };
    // Signal/protocol plumbing, edits, deletes, polls updates: not chat content.
    case "protocolMessage":
    case "senderKeyDistributionMessage":
    case "messageContextInfo":
    case "pollUpdateMessage":
    case undefined:
      return null;
    default:
      return { type: "unknown", body: "" };
  }
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export class WebTransport implements Transport {
  readonly name = "web";
  private sock?: WASocket;
  private handlers?: TransportHandlers;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  /** Ids of messages this process sent, so echoes are not recorded as phone messages. */
  private sentIds = new Set<string>();

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
  }

  private async connect(): Promise<void> {
    const handlers = this.handlers!;
    const db = getDb();
    await handlers.onState("connecting");

    const { state, saveCreds, clear } = await usePostgresAuthState(db);
    let version: [number, number, number] | undefined;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      // fall back to the version bundled with Baileys
    }

    const baileysLogger = log.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL ?? "warn" });
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any) },
      logger: baileysLogger as any,
      browser: Browsers.macOS("Desktop"),
      // Don't show as "online" on the phone, so it keeps receiving notifications.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Our own sends would otherwise be emitted back as new messages.
      emitOwnEvents: false,
      shouldIgnoreJid: (jid) =>
        Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)),
      // Lets WhatsApp re-request a message we sent when a recipient's device failed to decrypt it.
      getMessage: async (key) => {
        if (!key.id) return undefined;
        const [row] = await db.select({ body: messages.body }).from(messages).where(eq(messages.waMessageId, key.id));
        return row ? { conversation: row.body } : undefined;
      },
    });
    this.sock = sock;

    sock.ev.on("creds.update", () => {
      saveCreds().catch((err) => log.error({ err }, "Failed to save WhatsApp credentials"));
    });

    sock.ev.on("connection.update", async (update) => {
      try {
        if (update.qr) {
          await handlers.onState("qr", { qr: update.qr, detail: "Scan with WhatsApp → Linked devices → Link a device" });
          QRCode.toString(update.qr, { type: "terminal", small: true })
            .then((qr) => log.info(`Scan this QR code with WhatsApp (Linked devices):\n${qr}`))
            .catch(() => {});
        }
        if (update.connection === "open") {
          this.attempts = 0;
          const account = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
          log.info({ account }, "WhatsApp Web connected");
          await handlers.onState("connected", { account, qr: null, detail: sock.user?.name ?? undefined });
        }
        if (update.connection === "close") {
          const code = (update.lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
          if (this.stopped) return;
          if (code === DisconnectReason.loggedOut) {
            log.warn("WhatsApp Web session logged out; clearing credentials and requesting a new QR code");
            await clear();
            await handlers.onState("disconnected", { detail: "Logged out from the phone. Re-link by scanning a new QR code." });
            this.scheduleReconnect(1_000);
            return;
          }
          if (code === DisconnectReason.connectionReplaced) {
            await handlers.onState("error", {
              detail: "Another session replaced this connection (is a second worker running with the same account?)",
            });
          } else {
            await handlers.onState("disconnected", { detail: `Connection closed (${code ?? "unknown"}); reconnecting` });
          }
          this.scheduleReconnect();
        }
      } catch (err) {
        log.error({ err }, "Error handling WhatsApp connection update");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages: batch }) => {
      for (const m of batch) {
        try {
          await this.handleIncoming(m);
        } catch (err) {
          log.error({ err, id: m.key.id }, "Failed to handle WhatsApp message");
        }
      }
    });

    sock.ev.on("messages.update", async (updates) => {
      for (const { key, update } of updates) {
        if (!key.fromMe || !key.id || update.status == null) continue;
        const status = mapStatus(update.status);
        if (!status) continue;
        try {
          await handlers.onStatus({ waMessageId: key.id, status });
        } catch (err) {
          log.error({ err }, "Failed to apply WhatsApp status update");
        }
      }
    });
  }

  private scheduleReconnect(delay?: number) {
    if (this.stopped) return;
    this.attempts += 1;
    const wait = delay ?? Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.attempts - 1));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        log.error({ err }, "WhatsApp reconnect failed");
        this.scheduleReconnect();
      });
    }, wait);
  }

  private async handleIncoming(m: WAMessage): Promise<void> {
    const handlers = this.handlers!;
    const remoteJid = m.key.remoteJid;
    if (!remoteJid || !m.key.id || !m.message) return;
    if (isJidGroup(remoteJid) || isJidBroadcast(remoteJid) || isJidNewsletter(remoteJid) || isJidStatusBroadcast(remoteJid)) return;
    if (m.key.fromMe && this.sentIds.has(m.key.id)) return;

    const described = describeWebMessage(m.message);
    if (!described) return;

    const ts = new Date(Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000);
    if (Date.now() - ts.getTime() > config.web.maxBacklogHours * 3600_000) return;

    // WhatsApp increasingly addresses chats by LID (privacy id). Prefer the phone-number JID when known
    // so the same person maps to one contact.
    const alt = m.key.remoteJidAlt;
    const pnJid = isPnUser(remoteJid) ? remoteJid : alt && isPnUser(alt) ? alt : null;
    const waId = jidNormalizedUser(pnJid ?? remoteJid);
    const phone = pnJid ? jidDecode(pnJid)?.user ?? null : null;

    await handlers.onMessage({
      waId,
      phone,
      profileName: m.key.fromMe ? null : m.pushName ?? null,
      waMessageId: m.key.id,
      type: described.type,
      body: described.body,
      timestamp: ts,
      fromMe: Boolean(m.key.fromMe),
      meta: {
        remoteJid,
        ...(isLidUser(remoteJid) ? { lid: remoteJid } : {}),
      },
    });
  }

  private requireSocket(): WASocket {
    if (!this.sock?.user) throw new Error("WhatsApp Web is not connected (scan the QR code on the Status page)");
    return this.sock;
  }

  async sendText(to: SendTarget, body: string): Promise<{ waMessageId: string }> {
    const sock = this.requireSocket();
    const jid = to.waId.includes("@") ? to.waId : `${to.waId}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text: body });
    const id = sent?.key.id;
    if (!id) throw new Error("WhatsApp Web returned no message id");
    this.sentIds.add(id);
    if (this.sentIds.size > 5000) this.sentIds = new Set(Array.from(this.sentIds).slice(-1000));
    return { waMessageId: id };
  }

  async markRead(to: SendTarget, waMessageId: string, meta?: Record<string, unknown> | null): Promise<void> {
    const sock = this.requireSocket();
    const remoteJid = typeof meta?.remoteJid === "string" ? meta.remoteJid : to.waId;
    await sock.readMessages([{ remoteJid, id: waMessageId, fromMe: false }]);
  }
}

function mapStatus(status: number): "sent" | "delivered" | "read" | "failed" | null {
  // proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
  switch (status) {
    case 0:
      return "failed";
    case 2:
      return "sent";
    case 3:
      return "delivered";
    case 4:
    case 5:
      return "read";
    default:
      return null;
  }
}
