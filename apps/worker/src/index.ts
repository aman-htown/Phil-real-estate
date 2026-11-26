/**
 * Worker entrypoint. One long-running process that:
 *  1. connects to WhatsApp (transport chosen by WHATSAPP_TRANSPORT),
 *  2. stores inbound messages and schedules replies,
 *  3. drafts replies with Claude (responder loop),
 *  4. sends queued messages (outbox loop),
 *  5. publishes a heartbeat for the web UI's Status page,
 *  6. serves /health and, for the Cloud API, the WhatsApp webhook.
 */
import http from "node:http";
import { sql } from "drizzle-orm";
import {
  applyStatusUpdate,
  closeDb,
  failStuckSending,
  getDb,
  getSettings,
  ingestInbound,
  recordExternalOutbound,
  workerStatus,
} from "@phil/core";
import { config } from "./config";
import { log } from "./log";
import { startLoop } from "./loop";
import { runOutboxTick } from "./pipeline/outbox";
import { runResponderTick } from "./pipeline/responder";
import { createTransport, type ConnectionState, type TransportHandlers } from "./transports";

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

  const handlers: TransportHandlers = {
    async onMessage(event) {
      const result = event.fromMe ? await recordExternalOutbound(db, event) : await ingestInbound(db, event);
      if (!result.duplicate) {
        log.info(
          { conversationId: result.conversationId, from: event.waId, type: event.type, fromMe: !!event.fromMe },
          event.fromMe ? "Recorded message sent from phone" : "Inbound message",
        );
      }
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
