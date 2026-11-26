"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { api, fetcher, timeAgo } from "@/lib/client";
import { contactLabel, type ConversationListItem } from "@/lib/types";
import { IconAlert, IconPlus, IconSearch, IconSparkles, IconUsers, IconX } from "./icons";

const FILTERS = [
  { id: "open", label: "Open" },
  { id: "attention", label: "Attention" },
  { id: "drafts", label: "Drafts" },
  { id: "people", label: "People" },
  { id: "groups", label: "Groups" },
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
] as const;

function NewChat({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { id } = await api<{ id: string }>("POST", "/api/conversations", { phone, name: name || undefined });
          onClose();
          router.push(`/inbox/${id}`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not start chat");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex items-center justify-between text-xs font-medium text-slate-600">
        New chat
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
          <IconX width={14} height={14} />
        </button>
      </div>
      <input
        autoFocus
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="Phone with country code, e.g. +1 555 010 2030"
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-500"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-500"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button disabled={busy || !phone.trim()} className="w-full rounded-md bg-brand-600 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        Open chat
      </button>
    </form>
  );
}

const MODE_STYLE: Record<string, string> = {
  auto: "bg-brand-50 text-brand-700",
  draft: "bg-sky-50 text-sky-700",
  off: "bg-slate-100 text-slate-500",
};

export function ConversationList({ selectedId }: { selectedId?: string }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("open");
  const [q, setQ] = useState("");
  const [composing, setComposing] = useState(false);
  const key = `/api/conversations?filter=${filter}&q=${encodeURIComponent(q)}`;
  const { data, error, isLoading } = useSWR<ConversationListItem[]>(key, fetcher, {
    refreshInterval: 3000,
    keepPreviousData: true,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm focus-within:border-brand-500 focus-within:bg-white">
            <IconSearch className="shrink-0 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search names, numbers, messages"
              className="w-full bg-transparent outline-none placeholder:text-slate-400"
            />
          </label>
          <button
            onClick={() => setComposing((v) => !v)}
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-600 text-white hover:bg-brand-700"
            title="New chat"
            aria-label="New chat"
          >
            <IconPlus />
          </button>
        </div>
        {composing && <NewChat onClose={() => setComposing(false)} />}
        <div className="flex gap-1 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
                filter === f.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-scroll min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-4 text-sm text-red-600">{error.message}</p>}
        {isLoading && !data && <p className="p-4 text-sm text-slate-400">Loading…</p>}
        {data && data.length === 0 && (
          <p className="p-6 text-center text-sm text-slate-400">
            {q ? "No matches." : filter === "open" ? "No conversations yet. New WhatsApp messages will appear here." : "Nothing here."}
          </p>
        )}
        <ul>
          {data?.map((c) => {
            const active = c.id === selectedId;
            return (
              <li key={c.id}>
                <Link
                  href={`/inbox/${c.id}`}
                  className={`flex gap-3 border-b border-slate-100 px-3 py-3 ${active ? "bg-brand-50/70" : "hover:bg-slate-50"}`}
                >
                  <div
                    className={`grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold ${
                      c.contact.kind === "group" ? "bg-sky-100 text-sky-700" : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {c.contact.kind === "group" ? <IconUsers /> : contactLabel(c.contact).replace(/^\+/, "").slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={`truncate text-sm ${c.unreadCount ? "font-semibold" : "font-medium"}`}>
                        {contactLabel(c.contact)}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-slate-400">{timeAgo(c.lastMessageAt)}</span>
                    </div>
                    <p className={`truncate text-sm ${c.unreadCount ? "text-slate-800" : "text-slate-500"}`}>
                      {c.lastMessagePreview || "—"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${MODE_STYLE[c.effectiveMode]}`}>
                        {c.effectiveMode}
                      </span>
                      {c.needsAttention && (
                        <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700" title={c.attentionReason ?? ""}>
                          <IconAlert width={10} height={10} /> Attention
                        </span>
                      )}
                      {c.generating ? (
                        <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                          <IconSparkles width={10} height={10} /> Drafting
                        </span>
                      ) : (
                        c.hasPendingDraft && (
                          <span className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                            <IconSparkles width={10} height={10} /> Draft ready
                          </span>
                        )
                      )}
                      {c.intent && <span className="truncate text-[11px] text-slate-400">{c.intent}</span>}
                      {c.unreadCount > 0 && (
                        <span className="ml-auto rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{c.unreadCount}</span>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
