import { asc, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { workerStatus } from "@phil/core";
import { db, handler, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Worker considered offline when its heartbeat (every 15s) is older than this. */
const OFFLINE_AFTER_MS = 60_000;

export const GET = handler(async () => {
  const d = db();
  const [worker] = await d.select().from(workerStatus).orderBy(asc(workerStatus.id)).limit(1);
  const online = Boolean(worker && Date.now() - worker.lastHeartbeatAt.getTime() < OFFLINE_AFTER_MS && worker.state !== "disconnected");
  const qrDataUrl = worker?.state === "qr" && worker.qr ? await QRCode.toDataURL(worker.qr, { margin: 1, width: 280 }) : null;

  const [stats] = await d.execute<{
    conversations: number;
    needs_attention: number;
    pending_drafts: number;
    messages_today: number;
    ai_drafts_24h: number;
    avg_latency_ms_24h: number | null;
    input_tokens_24h: number;
    output_tokens_24h: number;
  }>(sql`
    select
      (select count(*)::int from conversations where status = 'open') as conversations,
      (select count(*)::int from conversations where needs_attention) as needs_attention,
      (select count(*)::int from drafts where status = 'pending') as pending_drafts,
      (select count(*)::int from messages where created_at > date_trunc('day', now())) as messages_today,
      (select count(*)::int from drafts where created_at > now() - interval '24 hours' and status <> 'error') as ai_drafts_24h,
      (select round(avg(latency_ms))::int from drafts where created_at > now() - interval '24 hours' and latency_ms is not null) as avg_latency_ms_24h,
      (select coalesce(sum(input_tokens), 0)::int from drafts where created_at > now() - interval '24 hours') as input_tokens_24h,
      (select coalesce(sum(output_tokens), 0)::int from drafts where created_at > now() - interval '24 hours') as output_tokens_24h
  `);

  return json({
    worker: worker ? { ...worker, qr: null } : null,
    online,
    qrDataUrl,
    stats: {
      conversations: stats?.conversations ?? 0,
      needsAttention: stats?.needs_attention ?? 0,
      pendingDrafts: stats?.pending_drafts ?? 0,
      messagesToday: stats?.messages_today ?? 0,
      aiDrafts24h: stats?.ai_drafts_24h ?? 0,
      avgLatencyMs24h: stats?.avg_latency_ms_24h ?? null,
      inputTokens24h: stats?.input_tokens_24h ?? 0,
      outputTokens24h: stats?.output_tokens_24h ?? 0,
    },
  });
});
