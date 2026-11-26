import { Nav } from "@/components/Nav";
import { currentSession } from "@/lib/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  return (
    <div className="flex h-dvh flex-col">
      <Nav userName={session?.name ?? ""} />
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
