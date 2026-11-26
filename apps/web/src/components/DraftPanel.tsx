"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { ConversationDetail } from "@/lib/types";
import { IconRefresh, IconSend, IconSparkles, IconTrash } from "./icons";

const ACTION_LABEL: Record<string, { label: string; cls: string }> = {
  reply: { label: "Suggested reply", cls: "bg-violet-100 text-violet-700" },
  escalate: { label: "Escalated to you", cls: "bg-amber-100 text-amber-800" },
  no_reply: { label: "No reply needed", cls: "bg-slate-100 text-slate-600" },
};

export function DraftPanel({
  detail,
  run,
}: {
  detail: ConversationDetail;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const draft = detail.latestDraft;
  const convKey = `/api/conversations/${detail.conversation.id}`;
  const lastMessage = detail.messages[detail.messages.length - 1];
  // A non-pending draft is only worth showing if nothing happened after it.
  const draftIsLatest = draft && (!lastMessage || new Date(draft.createdAt) >= new Date(lastMessage.createdAt));

  if (detail.generating && draft?.status !== "pending") {
    return (
      <div className="flex items-center gap-2 border-b border-violet-100 bg-violet-50/60 px-4 py-2 text-sm text-violet-700">
        <IconSparkles className="animate-pulse" />
        Claude is drafting a reply…
      </div>
    );
  }
  if (!draft) return null;

  if (draft.status === "pending") return <PendingDraft key={draft.id} detail={detail} run={run} />;

  if (draft.status === "skipped" && draftIsLatest) {
    return (
      <div className="flex items-start gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm text-slate-600">
        <IconSparkles className="mt-0.5 shrink-0 text-slate-400" />
        <p className="flex-1">
          <span className="font-medium">Claude suggests no reply.</span> {draft.operatorNote}
        </p>
        <button className="shrink-0 text-violet-700 underline" onClick={() => run(() => api("POST", `${convKey}/reply-request`))}>
          Draft anyway
        </button>
      </div>
    );
  }

  if (draft.status === "error" && draftIsLatest) {
    return (
      <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
        <p className="flex-1">
          <span className="font-medium">Claude couldn&apos;t draft a reply:</span> {draft.error}
        </p>
        <button className="shrink-0 underline" onClick={() => run(() => api("POST", `${convKey}/reply-request`))}>
          Try again
        </button>
      </div>
    );
  }
  return null;
}

function PendingDraft({
  detail,
  run,
}: {
  detail: ConversationDetail;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const draft = detail.latestDraft!;
  const [text, setText] = useState(draft.body);
  const saved = useRef(draft.body);
  const [busy, setBusy] = useState(false);
  const convKey = `/api/conversations/${detail.conversation.id}`;
  const action = ACTION_LABEL[draft.action ?? "reply"] ?? ACTION_LABEL.reply!;
  const edited = text.trim() !== draft.originalBody.trim();
  const newerMessages = detail.messages.some(
    (m) => m.direction === "inbound" && new Date(m.createdAt) > new Date(draft.createdAt),
  );

  // Auto-grow the textarea.
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  async function save() {
    if (text === saved.current) return;
    saved.current = text;
    await run(() => api("PATCH", `/api/drafts/${draft.id}`, { body: text }));
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    await run(fn);
    setBusy(false);
  }

  return (
    <div className="space-y-2 border-b border-violet-100 bg-violet-50/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${action.cls}`}>
          <IconSparkles width={12} height={12} /> {action.label}
        </span>
        {draft.urgency === "high" && <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">Urgent</span>}
        {edited && <span className="text-slate-500">Edited</span>}
        {detail.generating && <span className="animate-pulse text-violet-600">Re-drafting…</span>}
        <span className="ml-auto text-slate-400" title={`${draft.inputTokens ?? 0} in / ${draft.outputTokens ?? 0} out tokens`}>
          {draft.model}
          {draft.latencyMs ? ` · ${(draft.latencyMs / 1000).toFixed(1)}s` : ""}
        </span>
      </div>
      {draft.operatorNote && <p className="text-xs text-slate-600">{draft.operatorNote}</p>}
      {newerMessages && (
        <p className="text-xs text-amber-700">The contact wrote again after this draft was written. Consider regenerating.</p>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        placeholder={draft.action === "escalate" ? "No holding message suggested. Write one, or reply below." : ""}
        className="w-full resize-none rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy || !text.trim()}
          onClick={() => act(() => api("POST", `/api/drafts/${draft.id}/send`, { body: text }))}
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          <IconSend /> {edited ? "Send edited reply" : "Send reply"}
        </button>
        <button
          disabled={busy || detail.generating}
          onClick={() => act(() => api("POST", `${convKey}/reply-request`))}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <IconRefresh /> Regenerate
        </button>
        <button
          disabled={busy}
          onClick={() => act(() => api("POST", `/api/drafts/${draft.id}/discard`))}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          <IconTrash /> Discard
        </button>
      </div>
    </div>
  );
}
