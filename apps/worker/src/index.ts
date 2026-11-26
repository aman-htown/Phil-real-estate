/**
 * Worker entrypoint. One long-running process that:
 *  1. connects to WhatsApp (transport chosen by WHATSAPP_TRANSPORT),
 *  2. stores inbound messages and schedules replies,
 *  3. drafts replies with Claude (responder loop),
 *  4. sends queued messages (outbox loop),
 *  5. publishes a heartbeat for the web UI's Status page,
 *  6. serves /health and, for the Cloud API, the WhatsApp webhook.
 */
// Must be first: loads the repo-root .env before config.ts reads process.env.
import "@phil/core/load-root-env";
import http from "node:http";
import { sql } from "drizzle-orm";
import {
  applyStatusUpdate,
  closeDb,
  failStuckSending,
  getDb,
  getSettings,
  importHistory,
  ingestInbound,
  recordExternalOutbound,
  upsertGroups,
  workerStatus,
  type ChatRef,
} from "@phil/core";
import { config } from "./config";
import { log } from "./log";
import { startLoop } from "./loop";
import { runOutboxTick } from "./pipeline/outbox";
import { runResponderTick } from "./pipeline/responder";
import { createTransport, type ConnectionState, type InboundEvent, type TransportHandlers } from "./transports";

const VERSION = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "dev";

async function main() {
  if (config.runMigrations) {
    const { runMigrations } = await import("@phil/core/migrate");
    await runMigrations();
    log.info("Database migrations applied");
  }

  const db = getDb({ max: 10 });
  await getSettings(db); // creates the settings row on first boot
  await failStuckSending(db, 0);

  let state: ConnectionState = "starting";
  const publishStatus = async (patch: Partial<typeof workerStatus.$inferInsert> = {}) => {
    await db
      .insert(workerStatus)
      .values({ id: config.workerId, transport: config.transport, state, version: VERSION, ...patch })
      .onConflictDoUpdate({
        target: workerStatus.id,
        set: { transport: config.transport, state, version: VERSION, lastHeartbeatAt: sql`now()`, ...patch },
      });
  };
  await publishStatus({ startedAt: new Date(), qr: null, detail: null });

  const chatOf = (e: InboundEvent): ChatRef => ({
    waId: e.waId,
    kind: e.isGroup ? "group" : "person",
    phone: e.phone ?? null,
    name: e.profileName ?? null,
  });

  const handlers: TransportHandlers = {
    async onMessage(event) {
      const { waMessageId, type, body, timestamp, meta } = event;
      const result = event.fromMe
        ? await recordExternalOutbound(db, { chat: chatOf(event), waMessageId, type, body, timestamp, meta })
        : await ingestInbound(db, {
            chat: chatOf(event),
            sender: event.sender,
            waMessageId,
            type,
            body,
            timestamp,
            meta,
            allowReply: event.allowReply,
            mentionsMe: event.mentionsMe,
          });
      if (!result.duplicate && !result.ignored) {
        log.info(
          { conversationId: result.conversationId, chat: event.waId, group: !!event.isGroup, type, fromMe: !!event.fromMe },
          event.fromMe ? "Recorded message sent from phone" : "Inbound message",
        );
      }
    },
    async onGroups(groups, discovery) {
      const settings = await getSettings(db);
      // Groups the account was already in when it was linked are listed but not captured.
      const trackIfNew = discovery !== "baseline" && settings.autoTrackNewGroups;
      await upsertGroups(db, groups, { trackIfNew });
    },
    async onHistory(events) {
      const result = await importHistory(
        db,
        events.map((e) => ({
          chat: chatOf(e),
          sender: e.sender,
          fromMe: !!e.fromMe,
          waMessageId: e.waMessageId,
          type: e.type,
          body: e.body,
          timestamp: e.timestamp,
          meta: e.meta,
        })),
      );
      log.info(result, "History imported");
    },
    async onStatus(event) {
      await applyStatusUpdate(db, event);
    },
    async onState(next, info) {
      state = next;
      await publishStatus({
        ...(info?.detail !== undefined ? { detail: info.detail } : {}),
        ...(info?.qr !== undefined ? { qr: info.qr } : next === "connected" ? { qr: null } : {}),
        ...(info?.account !== undefined ? { account: info.account } : {}),
      });
    },
  };

  const transport = await createTransport(config.transport);
  await transport.start(handlers);
  log.info({ transport: transport.name }, "Transport started");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/health" || url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, transport: transport.name, state, version: VERSION }));
        return;
      }
      if (transport.handleHttp && (await transport.handleHttp(req, res, url))) return;
      res.writeHead(404).end("Not found");
    } catch (err) {
      log.error({ err }, "HTTP handler error");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(config.port, () => log.info({ port: config.port }, "HTTP server listening"));

  const loops = [
    startLoop("responder", config.pollIntervalMs, () => runResponderTick(db, config.responderConcurrency)),
    startLoop("outbox", config.pollIntervalMs, () => runOutboxTick(db, transport, () => state === "connected")),
    startLoop("heartbeat", 15_000, () => publishStatus()),
  ];

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Shutting down");
    server.close();
    await Promise.allSettled(loops.map((l) => l.stop()));
    await transport.stop().catch(() => {});
    state = "disconnected";
    await publishStatus({ detail: `Stopped (${signal})`, qr: null }).catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (err) => {
  log.fatal({ err }, "Worker failed to start");
  await closeDb().catch(() => {});
  process.exit(1);
});
