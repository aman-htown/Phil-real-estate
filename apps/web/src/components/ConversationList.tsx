"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { fetcher, timeAgo } from "@/lib/client";
import { contactLabel, type ConversationListItem } from "@/lib/types";
import { IconAlert, IconSearch, IconSparkles } from "./icons";

const FILTERS = [
  { id: "open", label: "Open" },
  { id: "attention", label: "Attention" },
  { id: "drafts", label: "Drafts" },
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
] as const;

const MODE_STYLE: Record<string, string> = {
  auto: "bg-brand-50 text-brand-700",
  draft: "bg-sky-50 text-sky-700",
  off: "bg-slate-100 text-slate-500",
};

export function ConversationList({ selectedId }: { selectedId?: string }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("open");
  const [q, setQ] = useState("");
  const key = `/api/conversations?filter=${filter}&q=${encodeURIComponent(q)}`;
  const { data, error, isLoading } = useSWR<ConversationListItem[]>(key, fetcher, {
    refreshInterval: 3000,
    keepPreviousData: true,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm focus-within:border-brand-500 focus-within:bg-white">
          <IconSearch className="text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search names, numbers, messages"
            className="w-full bg-transparent outline-none placeholder:text-slate-400"
          />
        </label>
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
                  <div className="grid size-10 shrink-0 place-items-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
                    {contactLabel(c.contact).replace(/^\+/, "").slice(0, 1).toUpperCase()}
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
