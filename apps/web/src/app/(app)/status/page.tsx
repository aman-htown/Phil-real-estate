"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, fetcher } from "@/lib/client";
import type { StatusDTO } from "@/lib/types";

const input =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function StatusPage() {
  const { data, error } = useSWR<StatusDTO>("/api/status", fetcher, { refreshInterval: 3000 });
  const w = data?.worker;

  return (
    <div className="pane-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
        <h1 className="text-xl font-semibold">Status</h1>
        {error && <p className="text-sm text-red-600">{error.message}</p>}

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-center gap-2">
            <span className={`size-2.5 rounded-full ${!data ? "bg-slate-300" : data.online && w?.state === "connected" ? "bg-brand-500" : data.online ? "bg-amber-500" : "bg-red-500"}`} />
            <h2 className="font-semibold">Worker</h2>
            <span className="text-sm text-slate-500">
              {!data ? "…" : !w ? "has never connected to the database" : data.online ? w.state : "offline (no heartbeat)"}
            </span>
          </div>
          {w && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Transport</dt>
              <dd>{w.transport === "cloud" ? "WhatsApp Cloud API" : w.transport === "web" ? "WhatsApp Web (linked device)" : "Mock (development)"}</dd>
              {w.account && (
                <>
                  <dt className="text-slate-500">Account</dt>
                  <dd className="truncate">{w.account}</dd>
                </>
              )}
              {w.detail && (
                <>
                  <dt className="text-slate-500">Detail</dt>
                  <dd>{w.detail}</dd>
                </>
              )}
              <dt className="text-slate-500">Last heartbeat</dt>
              <dd>{new Date(w.lastHeartbeatAt).toLocaleString()}</dd>
              <dt className="text-slate-500">Running since</dt>
              <dd>{new Date(w.startedAt).toLocaleString()}</dd>
              <dt className="text-slate-500">Version</dt>
              <dd className="font-mono text-xs">{w.version}</dd>
            </dl>
          )}
          {!w && data && (
            <p className="text-sm text-slate-600">
              Start the worker (<code className="rounded bg-slate-100 px-1">npm run dev:worker</code>) with the same DATABASE_URL as this site.
            </p>
          )}
          {data?.qrDataUrl && (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-slate-50 p-4 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.qrDataUrl} alt="WhatsApp pairing QR code" className="size-64 rounded-lg bg-white p-2" />
              <p className="text-sm text-slate-600">
                On the phone: WhatsApp → Settings → <b>Linked devices</b> → <b>Link a device</b>, then scan. The code refreshes every ~20s.
              </p>
            </div>
          )}
        </section>

        {data && (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Open conversations" value={data.stats.conversations} />
            <Stat label="Need attention" value={data.stats.needsAttention} />
            <Stat label="Drafts awaiting approval" value={data.stats.pendingDrafts} />
            <Stat label="Messages today" value={data.stats.messagesToday} />
            <Stat label="AI drafts (24h)" value={data.stats.aiDrafts24h} />
            <Stat label="Avg draft time (24h)" value={data.stats.avgLatencyMs24h ? `${(data.stats.avgLatencyMs24h / 1000).toFixed(1)}s` : "—"} />
            <Stat label="Input tokens (24h)" value={data.stats.inputTokens24h.toLocaleString()} />
            <Stat label="Output tokens (24h)" value={data.stats.outputTokens24h.toLocaleString()} />
          </section>
        )}

        <Simulator transport={w?.transport} />
      </div>
    </div>
  );
}

function Simulator({ transport }: { transport?: string }) {
  const [phone, setPhone] = useState("15550001234");
  const [name, setName] = useState("Test Buyer");
  const [body, setBody] = useState("Hi! Is the 3-bed on Elm Street still available? Could I see it this weekend?");
  const [group, setGroup] = useState("");
  const [mentionsMe, setMentionsMe] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; href?: string } | null>(null);

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
      <div>
        <h2 className="font-semibold">Simulate an inbound message</h2>
        <p className="text-sm text-slate-500">
          Pretend a contact wrote in, to test the AI pipeline end to end.
          {transport && transport !== "mock" && (
            <span className="text-amber-700"> The worker is on a real transport, so replies to this number are actually sent.</span>
          )}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (digits)" />
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      </div>
      <div className="grid items-center gap-3 sm:grid-cols-2">
        <input className={input} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Group name (optional: posts in a group)" />
        {group.trim() && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="accent-emerald-600" checked={mentionsMe} onChange={(e) => setMentionsMe(e.target.checked)} />
            @mentions the business
          </label>
        )}
      </div>
      <textarea className={input} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-3">
        <button
          onClick={async () => {
            setResult(null);
            try {
              const r = await api<{ conversationId?: string; ignored?: boolean }>("POST", "/api/simulate", {
                phone,
                name,
                body,
                ...(group.trim() ? { group: group.trim(), mentionsMe } : {}),
              });
              setResult(
                r.ignored
                  ? { ok: false, text: "That chat isn't tracked, so the message was ignored. Track it on the Groups page." }
                  : { ok: true, text: "Message received.", href: `/inbox/${r.conversationId}` },
              );
            } catch (err) {
              setResult({ ok: false, text: err instanceof Error ? err.message : "Failed" });
            }
          }}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Send test message
        </button>
        {result && (
          <span className={`text-sm ${result.ok ? "text-brand-700" : "text-red-600"}`}>
            {result.text}{" "}
            {result.href && (
              <a href={result.href} className="underline">
                Open conversation
              </a>
            )}
          </span>
        )}
      </div>
    </section>
  );
}
