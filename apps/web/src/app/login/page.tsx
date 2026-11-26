"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/client";

function LoginForm() {
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/auth/login", { name, password });
      const next = params.get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/inbox";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">W</span>
          <h1 className="text-lg font-semibold">WhatsApp Inbox</h1>
        </div>
        <p className="text-sm text-slate-500">Sign in to review and send replies.</p>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Your name</span>
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Shown on messages you send"
          autoComplete="name"
          required
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Team password</span>
        <input
          type="password"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-full place-items-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
