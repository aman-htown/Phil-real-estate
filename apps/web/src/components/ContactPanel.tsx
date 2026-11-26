"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { ConversationDetail } from "@/lib/types";
import { IconX } from "./icons";

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
  const { contact, conversation } = detail;
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

  return (
    <aside
      className={`${open ? "fixed inset-y-0 right-0 z-20 flex shadow-xl" : "hidden"} w-80 shrink-0 flex-col border-l border-slate-200 bg-white xl:static xl:flex xl:shadow-none`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Contact</h2>
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
          {contact.profileName && <span className="text-xs text-slate-400">WhatsApp name: {contact.profileName}</span>}
        </label>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-500">Phone</dt>
          <dd className="truncate">{contact.phone ? `+${contact.phone}` : "Unknown"}</dd>
          <dt className="text-slate-500">WhatsApp id</dt>
          <dd className="truncate" title={contact.waId}>{contact.waId}</dd>
          <dt className="text-slate-500">First seen</dt>
          <dd>{new Date(contact.createdAt).toLocaleDateString()}</dd>
        </dl>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500">Tags</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => {
              const next = tags.split(",").map((t) => t.trim()).filter(Boolean);
              if (next.join(",") !== contact.tags.join(",")) void save({ tags: next });
            }}
            placeholder="buyer, 3-bed, pre-approved"
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 outline-none focus:border-brand-500"
          />
        </label>

        <div className="space-y-1">
          <span className="text-xs font-medium text-slate-500">Team notes (Claude reads these)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={6}
            placeholder="Budget, preferred areas, properties viewed, family situation…"
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
      </div>
    </aside>
  );
}
