"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/client";
import type { StatusDTO } from "@/lib/types";

export function StatusPill() {
  const { data } = useSWR<StatusDTO>("/api/status", fetcher, { refreshInterval: 10_000 });
  const w = data?.worker;
  let tone = "bg-slate-300";
  let label = "Checking…";
  if (data) {
    if (!w) {
      label = "Worker never connected";
      tone = "bg-red-500";
    } else if (!data.online) {
      label = "Worker offline";
      tone = "bg-red-500";
    } else if (w.state === "qr") {
      label = "Scan QR to link WhatsApp";
      tone = "bg-amber-500";
    } else if (w.state === "connected") {
      label = w.transport === "mock" ? "Connected (mock)" : "WhatsApp connected";
      tone = "bg-brand-500";
    } else {
      label = `WhatsApp ${w.state}`;
      tone = "bg-amber-500";
    }
  }
  return (
    <Link href="/status" className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
      <span className={`size-2 rounded-full ${tone}`} />
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}
