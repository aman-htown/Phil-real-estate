"use client";

import { useParams } from "next/navigation";
import { ConversationList } from "@/components/ConversationList";

export function InboxShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>();
  const selectedId = params?.id;
  return (
    <div className="flex h-full">
      <aside
        className={`h-full w-full shrink-0 border-r border-slate-200 bg-white md:block md:w-80 lg:w-96 ${selectedId ? "hidden" : "block"}`}
      >
        <ConversationList selectedId={selectedId} />
      </aside>
      <section className={`h-full min-w-0 flex-1 ${selectedId ? "block" : "hidden md:block"}`}>{children}</section>
    </div>
  );
}
