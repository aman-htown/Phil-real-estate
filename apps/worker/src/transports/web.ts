/**
 * WhatsApp Web transport (Baileys). Links the worker to an existing WhatsApp
 * or WhatsApp Business app account as a "linked device", the same way
 * web.whatsapp.com does. Pair by scanning the QR code shown on the web UI's
 * Status page (or printed in the worker logs).
 *
 * This is the transport to use when you need:
 *  - groups created by other people (the Cloud API can't read those),
 *  - messages typed on the phone (they show as "sent from phone" and cancel pending AI replies),
 *  - chat history from before the worker was connected (imported when the phone is linked).
 *
 * Caveat: this is an unofficial client. WhatsApp may ban numbers that behave
 * like bots. Keep auto-replies conservative.
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
  type GroupMetadata,
  type WAMessage,
  type WASocket,
  type proto,
} from "baileys";
import { eq } from "drizzle-orm";
import { getDb, messages, type GroupInfo, type SenderRef } from "@phil/core";
import { config } from "../config";
import { log } from "../log";
import type { InboundEvent, SendTarget, Transport, TransportHandlers } from "./types";
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
    case "pollCreationMessage":
    case "pollCreationMessageV3":
      return { type: "text", body: `[poll] ${(msg.pollCreationMessage ?? msg.pollCreationMessageV3)?.name ?? ""}` };
    // Signal/protocol plumbing, edits, deletes, poll votes: not chat content.
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

function mentionedJids(content: proto.IMessage | null | undefined): string[] {
  const msg = normalizeMessageContent(content);
  const kind = msg ? getContentType(msg) : undefined;
  const inner = kind ? (msg as Record<string, any>)[kind] : undefined;
  const list = inner?.contextInfo?.mentionedJid;
  return Array.isArray(list) ? list : [];
}

const ignoredJid = (jid: string) =>
  Boolean(isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid));

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
  private groupCache = new Map<string, GroupMetadata>();
  private lidToPn = new Map<string, string>();
  private myIds = new Set<string>();
  /** Set when a new QR login happens: the groups seen right after are the baseline, not "new". */
  private baselinePending = false;
  /** Resolves once the first group list has been stored, so group messages and history wait for it. */
  private groupsReady: Promise<void>;
  private markGroupsReady!: () => void;
  private liveQueue: Promise<void> = Promise.resolve();
  private historyQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.groupsReady = new Promise((resolve) => (this.markGroupsReady = resolve));
  }

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
    if (!state.creds.registered) this.baselinePending = true;
    let version: [number, number, number] | undefined;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      // fall back to the version bundled with Baileys
    }

    const history = config.web.history;
    const baileysLogger = log.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL ?? "warn" });
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any) },
      logger: baileysLogger as any,
      browser: Browsers.macOS("Desktop"),
      // Don't show as "online" on the phone, so it keeps receiving notifications.
      markOnlineOnConnect: false,
      syncFullHistory: history === "full",
      ...(history === "full" ? { shouldSyncHistoryMessage: () => true } : {}),
      ...(history === "none" ? { shouldSyncHistoryMessage: () => false } : {}),
      // Our own sends would otherwise be emitted back as new messages.
      emitOwnEvents: false,
      shouldIgnoreJid: ignoredJid,
      // Sending to a group needs its member list; serve it from cache instead of refetching every time.
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
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
        if (update.isNewLogin) this.baselinePending = true;
        if (update.qr) {
          await handlers.onState("qr", { qr: update.qr, detail: "Scan with WhatsApp → Linked devices → Link a device" });
          QRCode.toString(update.qr, { type: "terminal", small: true })
            .then((qr) => log.info(`Scan this QR code with WhatsApp (Linked devices):\n${qr}`))
            .catch(() => {});
        }
        if (update.connection === "open") {
          this.attempts = 0;
          const user = sock.user;
          this.myIds = new Set([user?.id, user?.lid, user?.phoneNumber].filter(Boolean).map((j) => jidNormalizedUser(j!)));
          const account = user?.id ? jidNormalizedUser(user.id) : null;
          log.info({ account }, "WhatsApp Web connected");
          await handlers.onState("connected", { account, qr: null, detail: user?.name ?? undefined });
          void this.syncGroups(sock);
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

    sock.ev.on("messages.upsert", ({ messages: batch }) => {
      for (const m of batch) this.enqueue("live", () => this.handleLive(m));
    });

    sock.ev.on("messaging-history.set", ({ messages: batch, contacts, chats, lidPnMappings, progress }) => {
      for (const map of lidPnMappings ?? []) this.lidToPn.set(jidNormalizedUser(map.lid), jidNormalizedUser(map.pn));
      const names = new Map<string, string>();
      for (const c of contacts ?? []) {
        const name = c.name ?? c.notify ?? c.verifiedName;
        if (!name) continue;
        for (const jid of [c.id, c.lid, c.phoneNumber]) if (jid) names.set(jidNormalizedUser(jid), name);
      }
      for (const chat of chats ?? []) if (chat.id && chat.name) names.set(chat.id, chat.name);
      this.enqueue("history", async () => {
        await this.groupsReady;
        const events: InboundEvent[] = [];
        for (const m of batch) {
          const e = await this.toEvent(m, names);
          if (e) events.push(e);
        }
        log.info({ messages: events.length, progress }, "Importing WhatsApp history");
        await handlers.onHistory?.(events);
      });
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

    // The account was added to (or created) a group.
    sock.ev.on("groups.upsert", (groups) => {
      for (const g of groups) this.groupCache.set(g.id, g);
      this.enqueue("live", async () => {
        await this.groupsReady;
        await handlers.onGroups?.(groups.map((g) => this.toGroupInfo(g)), "live");
      });
    });
    sock.ev.on("groups.update", (updates) => {
      for (const u of updates) if (u.id) this.enqueue("live", () => this.refreshGroup(u.id!));
    });
    sock.ev.on("group-participants.update", ({ id }) => this.enqueue("live", () => this.refreshGroup(id)));
  }

  private enqueue(queue: "live" | "history", fn: () => Promise<void>) {
    const run = () =>
      fn().catch((err) => log.error({ err, queue }, "Failed to process WhatsApp event"));
    if (queue === "live") this.liveQueue = this.liveQueue.then(run);
    else this.historyQueue = this.historyQueue.then(run);
  }

  private async syncGroups(sock: WASocket) {
    try {
      const all = Object.values(await sock.groupFetchAllParticipating());
      for (const g of all) this.groupCache.set(g.id, g);
      const discovery = this.baselinePending ? "baseline" : "sync";
      await this.handlers?.onGroups?.(all.map((g) => this.toGroupInfo(g)), discovery);
      log.info({ groups: all.length, discovery }, "Synced WhatsApp groups");
      this.baselinePending = false;
    } catch (err) {
      log.error({ err }, "Failed to fetch WhatsApp groups");
    } finally {
      this.markGroupsReady();
    }
  }

  private async refreshGroup(jid: string) {
    const sock = this.sock;
    if (!sock) return;
    const known = this.groupCache.has(jid);
    try {
      const meta = await sock.groupMetadata(jid);
      this.groupCache.set(jid, meta);
      await this.groupsReady;
      await this.handlers?.onGroups?.([this.toGroupInfo(meta)], known ? "sync" : "live");
    } catch (err) {
      // e.g. we were removed from the group
      log.debug({ err, jid }, "Could not refresh group metadata");
    }
  }

  private toGroupInfo(g: GroupMetadata): GroupInfo {
    return {
      waId: g.id,
      subject: g.subject ?? null,
      participants: (g.participants ?? []).map((p) => {
        const pn = [p.phoneNumber, p.id].find((j) => j && isPnUser(j)) ?? this.lidToPn.get(jidNormalizedUser(p.id)) ?? null;
        return {
          waId: jidNormalizedUser(pn ?? p.id),
          phone: pn ? (jidDecode(pn)?.user ?? null) : null,
          name: p.notify ?? p.name ?? null,
          admin: Boolean(p.admin),
        };
      }),
    };
  }

  /**
   * WhatsApp increasingly addresses people by LID (a privacy id) instead of
   * their phone number. Prefer the phone-number JID when it can be found, so
   * the same person maps to one contact across DMs and groups.
   */
  private async person(jid: string, alt: string | null | undefined, name: string | null | undefined): Promise<SenderRef> {
    let pn: string | null = isPnUser(jid) ? jid : alt && isPnUser(alt) ? alt : null;
    if (!pn && isLidUser(jid)) {
      const key = jidNormalizedUser(jid);
      pn = this.lidToPn.get(key) ?? null;
      if (!pn && this.sock) {
        try {
          const found = await this.sock.signalRepository.lidMapping.getPNForLID(jid);
          if (found) {
            pn = jidNormalizedUser(found);
            this.lidToPn.set(key, pn);
          }
        } catch {
          // mapping unknown; fall back to the LID
        }
      }
    }
    return {
      waId: jidNormalizedUser(pn ?? jid),
      phone: pn ? (jidDecode(pn)?.user ?? null) : null,
      name: name ?? null,
    };
  }

  private async toEvent(m: WAMessage, names?: Map<string, string>): Promise<InboundEvent | null> {
    const remoteJid = m.key.remoteJid;
    if (!remoteJid || !m.key.id || !m.message || ignoredJid(remoteJid)) return null;
    const described = describeWebMessage(m.message);
    if (!described) return null;
    const timestamp = new Date(Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000);
    const fromMe = Boolean(m.key.fromMe);
    const base = { waMessageId: m.key.id, type: described.type, body: described.body, timestamp, fromMe };

    if (isJidGroup(remoteJid)) {
      const participant = m.key.participant ?? m.participant ?? null;
      const sender =
        !fromMe && participant
          ? await this.person(participant, m.key.participantAlt, m.pushName ?? names?.get(jidNormalizedUser(participant)))
          : undefined;
      return {
        ...base,
        waId: remoteJid,
        isGroup: true,
        profileName: this.groupCache.get(remoteJid)?.subject ?? names?.get(remoteJid) ?? null,
        sender,
        mentionsMe: !fromMe && mentionedJids(m.message).some((j) => this.myIds.has(jidNormalizedUser(j))),
        meta: { remoteJid, ...(participant ? { participant } : {}) },
      };
    }

    const who = await this.person(
      remoteJid,
      m.key.remoteJidAlt,
      fromMe ? null : (m.pushName ?? names?.get(jidNormalizedUser(remoteJid)) ?? null),
    );
    return {
      ...base,
      waId: who.waId,
      phone: who.phone,
      profileName: who.name,
      meta: { remoteJid, ...(isLidUser(remoteJid) ? { lid: remoteJid } : {}) },
    };
  }

  private async handleLive(m: WAMessage): Promise<void> {
    const remoteJid = m.key.remoteJid;
    if (!remoteJid || !m.key.id || ignoredJid(remoteJid)) return;
    if (m.key.fromMe && this.sentIds.has(m.key.id)) return;

    if (isJidGroup(remoteJid)) {
      await this.groupsReady;
      // A message from a group we've never seen means we were just added to it.
      if (!this.groupCache.has(remoteJid)) await this.refreshGroup(remoteJid);
    }

    const event = await this.toEvent(m);
    if (!event) return;
    // Old messages delivered after downtime are recorded, not answered.
    event.allowReply = Date.now() - event.timestamp.getTime() <= config.web.maxBacklogHours * 3600_000;
    await this.handlers!.onMessage(event);
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

  private requireSocket(): WASocket {
    if (!this.sock?.user) throw new Error("WhatsApp Web is not connected (scan the QR code on the Status page)");
    return this.sock;
  }

  async sendText(to: SendTarget, body: string): Promise<{ waMessageId: string }> {
    const sock = this.requireSocket();
    const jid = to.waId.includes("@") ? to.waId : `${to.waId}@s.whatsapp.net`;
    if (isJidGroup(jid) && !this.groupCache.has(jid)) {
      this.groupCache.set(jid, await sock.groupMetadata(jid));
    }
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
    const participant = typeof meta?.participant === "string" ? meta.participant : undefined;
    await sock.readMessages([{ remoteJid, id: waMessageId, fromMe: false, ...(participant ? { participant } : {}) }]);
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
