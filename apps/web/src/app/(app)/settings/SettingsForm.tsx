"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { api, fetcher } from "@/lib/client";
import type { SettingsDTO } from "@/lib/types";

const input =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-800">{label}</span>
      {children}
      {help && <span className="block text-xs text-slate-500">{help}</span>}
    </label>
  );
}

export function SettingsForm({ models, efforts }: { models: { id: string; label: string }[]; efforts: string[] }) {
  const { data, mutate } = useSWR<SettingsDTO>("/api/settings", fetcher);
  const [form, setForm] = useState<SettingsDTO | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  if (!form) return <p className="text-sm text-slate-400">Loading…</p>;
  const set = <K extends keyof SettingsDTO>(k: K, v: SettingsDTO[K]) => setForm({ ...form, [k]: v });
  const dirty = JSON.stringify(form) !== JSON.stringify(data);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setStatus(null);
    try {
      const { id: _id, updatedAt: _u, ...patch } = form;
      const saved = await api<SettingsDTO>("PUT", "/api/settings", patch);
      await mutate(saved, { revalidate: false });
      setForm(saved);
      setStatus({ ok: true, text: "Saved" });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Replying</h2>
        <div className={`rounded-xl border p-4 ${form.autoSendEnabled ? "border-brand-200 bg-brand-50/50" : "border-amber-200 bg-amber-50"}`}>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={form.autoSendEnabled}
              onChange={(e) => set("autoSendEnabled", e.target.checked)}
              className="mt-1 size-4 accent-emerald-600"
            />
            <span>
              <span className="block text-sm font-medium">Allow automatic sending</span>
              <span className="block text-xs text-slate-600">
                Master switch. When off, conversations in Auto mode get drafts for approval instead of sending.
              </span>
            </span>
          </label>
        </div>
        <Field label="Default mode for conversations" help="Each conversation can override this from its header.">
          <select className={input} value={form.defaultMode} onChange={(e) => set("defaultMode", e.target.value as SettingsDTO["defaultMode"])}>
            <option value="draft">Draft: Claude drafts, a person approves (recommended to start)</option>
            <option value="auto">Auto: Claude replies on its own</option>
            <option value="off">Off: no AI replies</option>
          </select>
        </Field>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={form.autoTrackNewGroups}
            onChange={(e) => set("autoTrackNewGroups", e.target.checked)}
            className="mt-1 size-4 accent-emerald-600"
          />
          <span>
            <span className="block text-sm font-medium">Track new groups automatically</span>
            <span className="block text-xs text-slate-600">
              When someone adds the business to a group, start capturing it in the inbox (assistant off). Groups the
              account was already in when WhatsApp was linked are listed on the Groups page to track by hand.
            </span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New groups: assistant" help="Applied when a group starts being tracked. Each group can be changed from its header.">
            <select className={input} value={form.groupDefaultMode} onChange={(e) => set("groupDefaultMode", e.target.value as SettingsDTO["groupDefaultMode"])}>
              <option value="auto">Auto: Claude sends its replies</option>
              <option value="draft">Draft: a person approves</option>
              <option value="off">Off</option>
            </select>
          </Field>
          <Field label="New groups: Claude replies" help="Private replies start a 1:1 chat with whoever wrote, about 5 seconds after their message.">
            <select className={input} value={form.groupReplyTarget} onChange={(e) => set("groupReplyTarget", e.target.value as SettingsDTO["groupReplyTarget"])}>
              <option value="sender">Privately, to each member who writes</option>
              <option value="chat">In the group</option>
            </select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Wait before replying (s)" help="Lets the contact finish typing several messages.">
            <input type="number" min={0} max={600} className={input} value={form.debounceSeconds} onChange={(e) => set("debounceSeconds", Number(e.target.value))} />
          </Field>
          <Field label="Messages of history" help="How many recent messages Claude reads.">
            <input type="number" min={4} max={200} className={input} value={form.historyLimit} onChange={(e) => set("historyLimit", Number(e.target.value))} />
          </Field>
          <Field label="Time zone" help="IANA name, e.g. America/New_York.">
            <input className={input} value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Voice and instructions</h2>
        <Field label="Business name">
          <input className={input} value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
        </Field>
        <Field
          label="Instructions for Claude"
          help="Who Claude speaks for, the tone, what to offer, and what never to promise. Facts like listings and fees belong in the Knowledge base."
        >
          <textarea rows={16} className={`${input} font-mono text-[13px] leading-relaxed`} value={form.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} />
        </Field>
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Model</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Claude model">
            <select className={input} value={form.model} onChange={(e) => set("model", e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort" help="Higher effort thinks longer: better on tricky messages, slower and pricier. Medium suits most chats.">
            <select className={input} value={form.effort} onChange={(e) => set("effort", e.target.value)}>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-slate-200 bg-[#f6f7f9]/95 py-3 backdrop-blur">
        <button type="submit" disabled={!dirty || busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? "Saving…" : "Save changes"}
        </button>
        {dirty && (
          <button type="button" onClick={() => data && setForm(data)} className="text-sm text-slate-500 hover:text-slate-800">
            Discard
          </button>
        )}
        {status && <span className={`text-sm ${status.ok ? "text-brand-700" : "text-red-600"}`}>{status.text}</span>}
      </div>
    </form>
  );
}
