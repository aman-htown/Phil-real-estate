"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/client";
import { IconActivity, IconBook, IconInbox, IconSettings } from "./icons";
import { StatusPill } from "./StatusPill";

const LINKS = [
  { href: "/inbox", label: "Inbox", Icon: IconInbox },
  { href: "/knowledge", label: "Knowledge", Icon: IconBook },
  { href: "/settings", label: "Settings", Icon: IconSettings },
  { href: "/status", label: "Status", Icon: IconActivity },
];

export function Nav({ userName }: { userName: string }) {
  const pathname = usePathname();
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-4 sm:px-4">
      <Link href="/inbox" className="flex items-center gap-2 font-semibold">
        <span className="grid size-7 place-items-center rounded-lg bg-brand-600 text-xs font-bold text-white">W</span>
        <span className="hidden md:inline">WhatsApp Inbox</span>
      </Link>
      <nav className="flex items-center gap-1">
        {LINKS.map(({ href, label, Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ${
                active ? "bg-slate-100 font-medium text-slate-900" : "text-slate-600 hover:bg-slate-50"
              }`}
              title={label}
            >
              <Icon />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <StatusPill />
        <button
          className="text-xs text-slate-500 hover:text-slate-800"
          title={`Signed in as ${userName}`}
          onClick={async () => {
            await api("POST", "/api/auth/logout");
            window.location.href = "/login";
          }}
        >
          <span className="hidden sm:inline">{userName} · </span>Sign out
        </button>
      </div>
    </header>
  );
}
