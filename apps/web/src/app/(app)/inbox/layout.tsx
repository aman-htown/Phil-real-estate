import { InboxShell } from "./InboxShell";

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <InboxShell>{children}</InboxShell>;
}
