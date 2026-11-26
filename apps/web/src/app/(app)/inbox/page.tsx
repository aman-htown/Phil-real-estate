import { IconInbox } from "@/components/icons";

export default function InboxIndex() {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-slate-400">
      <div className="space-y-2">
        <IconInbox width={32} height={32} className="mx-auto" />
        <p className="text-sm">Select a conversation to read it, review the AI draft, and reply.</p>
      </div>
    </div>
  );
}
