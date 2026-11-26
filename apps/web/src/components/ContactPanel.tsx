"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { ConversationDetail } from "@/lib/types";
import { IconMessage, IconUsers, IconX } from "./icons";

export function ContactPanel({
  detail,
  open,
  onClose,
  run,
}: {
  detail: ConversationDetail;
  open: boolean;
  onClose: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const router = useRouter();
  const { contact, conversation } = detail;
  const isGroup = contact.kind === "group";
  const [displayName, setDisplayName] = useState(contact.displayName ?? "");
  const [notes, setNotes] = useState(contact.notes);
  const [tags, setTags] = useState(contact.tags.join(", "));

  // Reset local edits when switching conversations.
  useEffect(() => {
    setDisplayName(contact.displayName ?? "");
    setNotes(contact.notes);
    setTags(contact.tags.join(", "));
  }, [contact.id]);

  const save = (patch: Record<string, unknown>) => run(() => api("PATCH", `/api/contacts/${contact.id}`, patch));
  const notesDirty = notes !== contact.notes;

  const messagePrivately = (contactId: string) =>
    run(async () => {
      const { id } = await api<{ id: string }>("POST", "/api/conversations", { contactId });
      router.push(`/inbox/${id}`);
    });

  const stopTracking = async () => {
    const what = isGroup ? "this group" : "this person";
    const ok = confirm(
      `Stop tracking ${what}?\n\nAll ${detail.messages.length} stored messages and drafts for this chat will be deleted, and new messages won't be captured. You can track it again from the Groups page.`,
    );
    if (!ok) return;
    await run(async () => {
      await api("PATCH", `/api/contacts/${contact.id}`, { tracked: false });
      router.push("/inbox");
    });
  };

  return (
    <aside
      className={`${open ? "fixed inset-y-0 right-0 z-20 flex shadow-xl" : "hidden"} w-80 shrink-0 flex-col border-l border-slate-200 bg-white xl:static xl:flex xl:shadow-none`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">{isGroup ? "Group" : "Contact"}</h2>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 xl:hidden" aria-label="Close">
          <IconX />
        </button>
      </div>
      <div className="pane-scroll flex-1 space-y-5 overflow-y-auto p-4 text-sm">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500">Name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => displayName !== (contact.displayName ?? "") && save({ displayName: displayName || null })}
            placeholder={contact.profileName ?? "Add a name"}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 outline-none focus:border-brand-500"
          />
          {contact.profileName && (
            <span className="text-xs text-slate-400">
              {isGroup ? "WhatsApp group name" : "WhatsApp name"}: {contact.profileName}
            </span>
          )}
        </label>

        {!isGroup && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-500">Phone</dt>
            <dd className="truncate">{contact.phone ? `+${contact.phone}` : "Unknown"}</dd>
            <dt className="text-slate-500">WhatsApp id</dt>
            <dd className="truncate" title={contact.waId}>
              {contact.waId}
            </dd>
            <dt className="text-slate-500">First seen</dt>
            <dd>{new Date(contact.createdAt).toLocaleDateString()}</dd>
          </dl>
        )}

        {isGroup && (
          <div className="space-y-2">
            <span className="text-xs font-medium text-slate-500">
              Members ({detail.participants.length}
              {detail.participants.length ? "" : ", list loads once WhatsApp shares it"})
            </span>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {detail.participants.map((p) => (
                <li key={p.waId} className="flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {p.name || (p.phone ? `+${p.phone}` : "Unknown")}
                      {p.admin && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500">admin</span>}
                    </div>
                    {p.name && p.phone && <div className="truncate text-xs text-slate-400">+{p.phone}</div>}
                  </div>
                  {p.conversationId ? (
                    <Link href={`/inbox/${p.conversationId}`} className="flex shrink-0 items-center gap-1 text-xs text-brand-700 hover:underline">
                      <IconMessage width={12} height={12} /> Chat
                    </Link>
                  ) : p.contactId ? (
                    <button
                      onClick={() => messagePrivately(p.contactId!)}
                      className="flex shrink-0 items-center gap-1 text-xs text-slate-500 hover:text-brand-700"
                    >
                      <IconMessage width={12} height={12} /> Message
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!isGroup && detail.groups.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs font-medium text-slate-500">Also in these groups</span>
            <ul className="space-y-1">
              {detail.groups.map((g) => (
                <li key={g.contactId}>
                  {g.conversationId ? (
                    <Link href={`/inbox/${g.conversationId}`} className="flex items-center gap-1.5 text-sm text-sky-700 hover:underline">
                      <IconUsers width={14} height={14} /> {g.name ?? "Unnamed group"}
                    </Link>
                  ) : (
                    <span className="flex items-center gap-1.5 text-sm text-slate-500">
                      <IconUsers width={14} height={14} /> {g.name ?? "Unnamed group"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500">Tags</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => {
              const next = tags.split(",").map((t) => t.trim()).filter(Boolean);
              if (next.join(",") !== contact.tags.join(",")) void save({ tags: next });
            }}
            placeholder={isGroup ? "developer, new build, 2026 launch" : "buyer, 3-bed, pre-approved"}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 outline-none focus:border-brand-500"
          />
        </label>

        <div className="space-y-1">
          <span className="text-xs font-medium text-slate-500">Team notes (Claude reads these)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={6}
            placeholder={
              isGroup
                ? "Who set up the group, what it's for, who the decision-makers are…"
                : "Budget, preferred areas, properties viewed, family situation…"
            }
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 outline-none focus:border-brand-500"
          />
          {notesDirty && (
            <button onClick={() => save({ notes })} className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white">
              Save notes
            </button>
          )}
        </div>

        <div className="space-y-1">
          <span className="text-xs font-medium text-slate-500">AI summary</span>
          <p className="rounded-lg bg-slate-50 p-2.5 text-slate-700">{conversation.summary || "No summary yet."}</p>
          {conversation.intent && <p className="text-xs text-slate-500">Intent: {conversation.intent}</p>}
        </div>

        <div className="border-t border-slate-100 pt-4">
          <button onClick={stopTracking} className="text-xs text-slate-500 underline hover:text-red-600">
            {isGroup ? "Stop tracking this group" : "Not a customer: stop tracking this chat"}
          </button>
          <p className="mt-1 text-xs text-slate-400">Deletes the stored messages and ignores new ones.</p>
        </div>
      </div>
    </aside>
  );
}
