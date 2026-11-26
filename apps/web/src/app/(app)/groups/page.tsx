"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { IconUsers } from "@/components/icons";
import { api, fetcher, timeAgo } from "@/lib/client";
import type { GroupsDTO } from "@/lib/types";

export default function GroupsPage() {
  const { data, error, mutate } = useSWR<GroupsDTO>("/api/groups", fetcher, { refreshInterval: 5000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function setTracked(contactId: string, tracked: boolean, name: string | null) {
    if (!tracked && !confirm(`Stop tracking “${name ?? "this chat"}”?\n\nIts stored messages and drafts will be deleted and new messages ignored.`)) return;
    setBusy(contactId);
    setErr(null);
    try {
      await api("PATCH", `/api/contacts/${contactId}`, { tracked });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    }
    await mutate();
    setBusy(null);
  }

  const tracked = data?.groups.filter((g) => g.tracked) ?? [];
  const untracked = data?.groups.filter((g) => !g.tracked) ?? [];

  return (
    <div className="pane-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
        <div>
          <h1 className="text-xl font-semibold">Groups</h1>
          <p className="max-w-xl text-sm text-slate-500">
            WhatsApp groups the business account belongs to. Tracked groups appear in the inbox with every message and
            who wrote it, so you can reply in the group or message any member privately. Claude stays off in groups
            unless you turn it on for one.
          </p>
        </div>

        {data && data.transport !== "web" && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Groups need the WhatsApp Web transport (the worker is on{" "}
            <b>{data.transport ?? "no transport yet"}</b>). The Cloud API can&apos;t read groups created by other people.
            Set <code>WHATSAPP_TRANSPORT=web</code> on the worker and link the phone from the Status page.
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error.message}</p>}
        {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Tracked ({tracked.length})</h2>
          {data && tracked.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
              No tracked groups. New groups the account is added to are tracked automatically (see Settings), or track one
              below.
            </p>
          )}
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            {tracked.map((g) => (
              <li key={g.contactId} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sky-100 text-sky-700">
                  <IconUsers />
                </span>
                <div className="min-w-0 flex-1">
                  {g.conversationId ? (
                    <Link href={`/inbox/${g.conversationId}`} className="block truncate font-medium hover:underline">
                      {g.name ?? "Unnamed group"}
                    </Link>
                  ) : (
                    <span className="block truncate font-medium">{g.name ?? "Unnamed group"}</span>
                  )}
                  <span className="text-xs text-slate-500">
                    {g.members} members{g.lastMessageAt ? ` · last message ${timeAgo(g.lastMessageAt)}` : ""}
                  </span>
                </div>
                <button
                  disabled={busy === g.contactId}
                  onClick={() => setTracked(g.contactId, false, g.name)}
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-red-600 disabled:opacity-50"
                >
                  Stop tracking
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Not tracked ({untracked.length})</h2>
          <p className="text-xs text-slate-500">
            Messages from these groups aren&apos;t stored. Tracking starts from the next message.
          </p>
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            {untracked.map((g) => (
              <li key={g.contactId} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-400">
                  <IconUsers />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-700">{g.name ?? "Unnamed group"}</span>
                  <span className="text-xs text-slate-500">{g.members} members</span>
                </div>
                <button
                  disabled={busy === g.contactId}
                  onClick={() => setTracked(g.contactId, true, g.name)}
                  className="shrink-0 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  Track
                </button>
              </li>
            ))}
            {data && untracked.length === 0 && <li className="px-4 py-3 text-sm text-slate-400">None.</li>}
          </ul>
        </section>

        {data && data.untrackedPeople.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">Untracked people ({data.untrackedPeople.length})</h2>
            <p className="text-xs text-slate-500">Chats marked “not a customer”. Their messages aren&apos;t stored.</p>
            <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
              {data.untrackedPeople.map((p) => (
                <li key={p.contactId} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {p.name ?? (p.phone ? `+${p.phone}` : p.waId)}
                    {p.name && p.phone && <span className="ml-2 text-xs text-slate-400">+{p.phone}</span>}
                  </span>
                  <button
                    disabled={busy === p.contactId}
                    onClick={() => setTracked(p.contactId, true, p.name)}
                    className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                  >
                    Track again
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
