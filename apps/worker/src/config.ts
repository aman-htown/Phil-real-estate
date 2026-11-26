export type TransportName = "cloud" | "web" | "mock";

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function required(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const transport = (env("WHATSAPP_TRANSPORT", "mock") as TransportName);
if (!["cloud", "web", "mock"].includes(transport)) {
  throw new Error(`WHATSAPP_TRANSPORT must be cloud, web or mock (got "${transport}")`);
}

export const config = {
  transport,
  port: Number(env("PORT", "8080")),
  runMigrations: env("RUN_MIGRATIONS", "false") === "true",
  /** How often the responder and outbox poll Postgres. */
  pollIntervalMs: Number(env("POLL_INTERVAL_MS", "1500")),
  /** Max conversations Claude works on at once. */
  responderConcurrency: Number(env("RESPONDER_CONCURRENCY", "3")),
  workerId: env("WORKER_ID", "main")!,
  cloud: {
    get accessToken() {
      return required("WHATSAPP_ACCESS_TOKEN");
    },
    get phoneNumberId() {
      return required("WHATSAPP_PHONE_NUMBER_ID");
    },
    get verifyToken() {
      return required("WHATSAPP_VERIFY_TOKEN");
    },
    /** Used to verify X-Hub-Signature-256 on webhooks. Strongly recommended. */
    appSecret: env("WHATSAPP_APP_SECRET"),
    graphVersion: env("WHATSAPP_GRAPH_VERSION", "v24.0")!,
  },
  web: {
    /** Ignore WhatsApp Web messages older than this on reconnect (avoids replying to stale backlog). */
    maxBacklogHours: Number(env("WEB_MAX_BACKLOG_HOURS", "12")),
  },
};
