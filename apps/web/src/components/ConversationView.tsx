"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { api, clockTime, dayLabel, fetcher } from "@/lib/client";
import { contactLabel, type ConversationDetail } from "@/lib/types";
import { ContactPanel } from "./ContactPanel";
import { DraftPanel } from "./DraftPanel";
import {
  IconAlert,
  IconArchive,
  IconCheck,
  IconChecks,
  IconChevronLeft,
  IconClock,
  IconSend,
  IconSparkles,
  IconUser,
} from "./icons";

type Msg = ConversationDetail["messages"][number];

const MODES = [
  { id: null, label: "Default" },
  { id: "auto", label: "Auto" },
  { id: "draft", label: "Draft" },
  { id: "off", label: "Off" },
] as const;

const MODE_HELP: Record<string, string> = {
  auto: "Claude replies automatically",
  draft: "Claude drafts, a person approves",
  off: "Claude stays silent",
};

const TYPE_LABEL: Record<string, string> = {
  image: "Photo",
  video: "Video",
  audio: "Voice note",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contacts: "Contact card",
  reaction: "Reaction",
  unknown: "Unsupported message",
};

function sourceLabel(m: Msg): string | null {
  switch (m.source) {
    case "ai_auto":
      return "AI · auto";
    case "ai_approved":
      return m.author ? `AI · approved by ${m.author}` : "AI · approved";
    case "human":
      return m.author ?? "Team";
    case "external":
      return "Sent from phone";
    default:
      return null;
  }
}

function StatusIcon({ m }: { m: Msg }) {
  switch (m.status) {
    case "queued":
    case "sending":
      return <IconClock width={12} height={12} className="text-slate-400" aria-label="Sending" />;
    case "sent":
      return <IconCheck width={12} height={12} className="text-slate-400" aria-label="Sent" />;
    case "delivered":
      return <IconChecks width={13} height={13} className="text-slate-400" aria-label="Delivered" />;
    case "read":
      return <IconChecks width={13} height={13} className="text-sky-500" aria-label="Read" />;
    case "failed":
      return <IconAlert width={12} height={12} className="text-red-500" aria-label="Failed" />;
    default:
      return null;
  }
}

function MessageBubble({ m, onRetry }: { m: Msg; onRetry: (id: string) => void }) {
  const out = m.direction === "outbound";
  const label = out ? sourceLabel(m) : null;
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${
          out
            ? m.status === "failed"
              ? "rounded-br-md border border-red-200 bg-red-50"
              : "rounded-br-md bg-brand-100/70"
            : "rounded-bl-md bg-white"
        }`}
      >
        {m.type !== "text" && (
          <div className="mb-0.5 text-xs font-medium text-slate-500">[{TYPE_LABEL[m.type] ?? m.type}]</div>
        )}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-slate-400">
          {label && <span className={m.source.startsWith("ai") ? "text-violet-500" : ""}>{label}</span>}
          <span>{clockTime(m.createdAt)}</span>
          {out && <StatusIcon m={m} />}
        </div>
        {m.status === "failed" && (
          <div className="mt-1 space-y-1 border-t border-red-200 pt-1 text-xs text-red-700">
            <p>{m.error ?? "Failed to send"}</p>
            <button className="font-medium underline" onClick={() => onRetry(m.id)}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConversationView({ id }: { id: string }) {
  const key = `/api/conversations/${id}`;
  const { data, error, mutate } = useSWR<ConversationDetail>(key, fetcher, { refreshInterval: 2500 });
  const { mutate: globalMutate } = useSWRConfig();
  const [showContact, setShowContact] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      mutate(),
      globalMutate((k) => typeof k === "string" && k.startsWith("/api/conversations?")),
    ]);
  }, [mutate, globalMutate]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        await refreshAll();
      }
    },
    [refreshAll],
  );

  // Opening a conversation marks it read in the inbox.
  const unread = data?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0) void run(() => api("PATCH", key, { markRead: true }));
  }, [unread, key, run]);

  // Keep the thread pinned to the newest message.
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = data?.messages.length ?? 0;
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (lastCount.current === 0 || nearBottom) el.scrollTop = el.scrollHeight;
    lastCount.current = count;
  }, [count, data?.latestDraft?.id, data?.generating]);
  useEffect(() => {
    lastCount.current = 0;
  }, [id]);

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">
        {error.message}{" "}
        <Link href="/inbox" className="underline">
          Back to inbox
        </Link>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-sm text-slate-400">Loading…</div>;

  const { conversation, contact, messages } = data;
  const lastInbound = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : null;
  const outsideWindow = data.transport === "cloud" && (!lastInbound || Date.now() - lastInbound > 24 * 3600_000);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-3 py-2">
          <Link href="/inbox" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back">
            <IconChevronLeft />
          </Link>
          <button className="min-w-0 text-left" onClick={() => setShowContact((s) => !s)}>
            <div className="truncate font-semibold">{contactLabel(contact)}</div>
            <div className="truncate text-xs text-slate-500">
              {contact.phone ? `+${contact.phone}` : contact.waId}
              {conversation.intent ? ` · ${conversation.intent}` : ""}
            </div>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs" role="radiogroup" aria-label="Assistant mode">
              {MODES.map((m) => {
                const active = conversation.mode === m.id;
                const title = m.id ? MODE_HELP[m.id] : `Use the default from Settings (${data.defaultMode})`;
                return (
                  <button
                    key={m.label}
                    role="radio"
                    aria-checked={active}
                    title={title}
                    onClick={() => run(() => api("PATCH", key, { mode: m.id }))}
                    className={`rounded-md px-2 py-1 ${active ? "bg-white font-medium shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                  >
                    {m.id ? m.label : `Default (${data.defaultMode})`}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() =>
                run(() => api("PATCH", key, { status: conversation.status === "archived" ? "open" : "archived" }))
              }
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
              title={conversation.status === "archived" ? "Unarchive" : "Archive"}
            >
              <IconArchive />
            </button>
            <button
              onClick={() => setShowContact((s) => !s)}
              className={`rounded-lg p-1.5 hover:bg-slate-100 xl:hidden ${showContact ? "text-brand-600" : "text-slate-500"}`}
              title="Contact details"
            >
              <IconUser />
            </button>
          </div>
        </div>

        {conversation.needsAttention && (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            <IconAlert className="mt-0.5 shrink-0" />
            <p className="flex-1">{conversation.attentionReason || "Needs attention"}</p>
            <button
              className="shrink-0 font-medium underline"
              onClick={() => run(() => api("PATCH", key, { needsAttention: false }))}
            >
              Resolve
            </button>
          </div>
        )}
        {conversation.status === "archived" && (
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-xs text-slate-500">
            Archived. It reopens automatically when the contact writes again.
          </div>
        )}

        {/* Thread */}
        <div ref={scrollRef} className="pane-scroll min-h-0 flex-1 space-y-2 overflow-y-auto bg-[#efeae2]/60 px-3 py-4 sm:px-6">
          {messages.length === 0 && <p className="text-center text-sm text-slate-400">No messages yet.</p>}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return (
              <div key={m.id} className="space-y-2">
                {newDay && (
                  <div className="flex justify-center">
                    <span className="rounded-full bg-white/80 px-3 py-0.5 text-xs text-slate-500 shadow-sm">
                      {dayLabel(m.createdAt)}
                    </span>
                  </div>
                )}
                <MessageBubble m={m} onRetry={(mid) => run(() => api("POST", `/api/messages/${mid}/retry`))} />
              </div>
            );
          })}
        </div>

        {/* AI draft + composer */}
        <div className="border-t border-slate-200 bg-white">
          {actionError && (
            <p className="flex items-center justify-between bg-red-50 px-4 py-1.5 text-xs text-red-700">
              {actionError}
              <button onClick={() => setActionError(null)} className="underline">
                Dismiss
              </button>
            </p>
          )}
          <DraftPanel detail={data} run={run} />
          {outsideWindow && (
            <p className="bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
              More than 24 hours since this contact last wrote. WhatsApp only allows approved template messages now, so
              free-form messages will fail until they write again.
            </p>
          )}
          <Composer
            onSend={(body) => run(() => api("POST", `${key}/messages`, { body }))}
            onDraft={() => run(() => api("POST", `${key}/reply-request`))}
            generating={data.generating}
          />
        </div>
      </div>

      <ContactPanel detail={data} open={showContact} onClose={() => setShowContact(false)} run={run} />
    </div>
  );
}

function Composer({
  onSend,
  onDraft,
  generating,
}: {
  onSend: (body: string) => Promise<void>;
  onDraft: () => Promise<void>;
  generating: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    await onSend(body);
    setText("");
    setBusy(false);
  }

  return (
    <div className="flex items-end gap-2 p-3">
      <button
        onClick={() => void onDraft()}
        disabled={generating}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-violet-200 px-2.5 py-2 text-sm text-violet-700 hover:bg-violet-50 disabled:opacity-50"
        title="Ask Claude to draft a reply now"
      >
        <IconSparkles />
        <span className="hidden sm:inline">Draft with AI</span>
      </button>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        placeholder="Type a message…"
        title="Enter to send, Shift+Enter for a new line"
        className="min-h-10 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
      <button
        onClick={() => void send()}
        disabled={!text.trim() || busy}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <IconSend />
        <span className="hidden sm:inline">Send</span>
      </button>
    </div>
  );
}
