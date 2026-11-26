"use client";

import { useState } from "react";
import useSWR from "swr";
import { IconPlus, IconTrash } from "@/components/icons";
import { api, fetcher } from "@/lib/client";
import type { KnowledgeDTO } from "@/lib/types";

const input =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function Editor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Pick<KnowledgeDTO, "title" | "content">;
  onSave: (v: { title: string; content: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <input className={input} placeholder="Title, e.g. “12 Elm St: 3-bed townhouse”" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        className={`${input} min-h-40`}
        placeholder="Facts Claude can use: price, size, features, availability, viewing rules, fees, FAQs…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          disabled={busy || !title.trim() || !content.trim()}
          onClick={async () => {
            setBusy(true);
            await onSave({ title, content });
            setBusy(false);
          }}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  const { data, mutate, error } = useSWR<KnowledgeDTO[]>("/api/knowledge", fetcher);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const guard = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    }
    await mutate();
  };

  const enabledChars = (data ?? []).filter((k) => k.enabled).reduce((n, k) => n + k.title.length + k.content.length, 0);

  return (
    <div className="pane-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Knowledge base</h1>
            <p className="max-w-xl text-sm text-slate-500">
              Listings, fees, process, areas covered, FAQs. Every enabled entry is given to Claude with each reply, and it
              won&apos;t state facts that aren&apos;t here.
            </p>
            {data && (
              <p className="mt-1 text-xs text-slate-400">
                {data.filter((k) => k.enabled).length} enabled · ~{Math.round(enabledChars / 4).toLocaleString()} tokens per reply
              </p>
            )}
          </div>
          {!adding && (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
              <IconPlus /> Add entry
            </button>
          )}
        </div>

        {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
        {error && <p className="text-sm text-red-600">{error.message}</p>}

        {adding && (
          <div className="rounded-2xl border border-brand-200 bg-white p-4">
            <Editor
              onCancel={() => setAdding(false)}
              onSave={(v) =>
                guard(async () => {
                  await api("POST", "/api/knowledge", v);
                  setAdding(false);
                })
              }
            />
          </div>
        )}

        {data && data.length === 0 && !adding && (
          <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            Nothing yet. Start with your current listings and a short FAQ (fees, how viewings work, areas you cover).
          </div>
        )}

        <ul className="space-y-3">
          {data?.map((k) => (
            <li key={k.id} className={`rounded-2xl border bg-white p-4 ${k.enabled ? "border-slate-200" : "border-slate-200 opacity-60"}`}>
              {editing === k.id ? (
                <Editor
                  initial={k}
                  onCancel={() => setEditing(null)}
                  onSave={(v) =>
                    guard(async () => {
                      await api("PATCH", `/api/knowledge/${k.id}`, v);
                      setEditing(null);
                    })
                  }
                />
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-3">
                    <h3 className="flex-1 font-medium">{k.title}</h3>
                    <label className="flex items-center gap-1.5 text-xs text-slate-500">
                      <input
                        type="checkbox"
                        className="accent-emerald-600"
                        checked={k.enabled}
                        onChange={(e) => guard(() => api("PATCH", `/api/knowledge/${k.id}`, { enabled: e.target.checked }))}
                      />
                      Enabled
                    </label>
                    <button onClick={() => setEditing(k.id)} className="text-xs text-slate-500 underline hover:text-slate-800">
                      Edit
                    </button>
                    <button
                      onClick={() => confirm(`Delete “${k.title}”?`) && guard(() => api("DELETE", `/api/knowledge/${k.id}`))}
                      className="text-slate-400 hover:text-red-600"
                      aria-label="Delete"
                    >
                      <IconTrash />
                    </button>
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-600">{k.content}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
