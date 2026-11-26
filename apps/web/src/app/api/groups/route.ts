import { and, asc, desc, eq, sql } from "drizzle-orm";
import { contacts, conversations, workerStatus } from "@phil/core";
import { db, handler, json } from "@/lib/server";
import type { GroupsDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Every WhatsApp group the account is in (tracked or not), plus people who were untracked. */
export const GET = handler(async () => {
  const d = db();
  const groups = await d
    .select({
      contactId: contacts.id,
      waId: contacts.waId,
      name: sql<string | null>`coalesce(${contacts.displayName}, ${contacts.profileName})`,
      tracked: contacts.tracked,
      members: sql<number>`coalesce(jsonb_array_length(${contacts.participants}), 0)::int`,
      conversationId: conversations.id,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(contacts)
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(eq(contacts.kind, "group"))
    .orderBy(desc(contacts.tracked), sql`${conversations.lastMessageAt} desc nulls last`, asc(contacts.profileName));
  const untrackedPeople = await d
    .select({
      contactId: contacts.id,
      waId: contacts.waId,
      name: sql<string | null>`coalesce(${contacts.displayName}, ${contacts.profileName})`,
      phone: contacts.phone,
    })
    .from(contacts)
    .where(and(eq(contacts.kind, "person"), eq(contacts.tracked, false)))
    .orderBy(asc(contacts.profileName));
  const [worker] = await d.select({ transport: workerStatus.transport }).from(workerStatus).orderBy(asc(workerStatus.id)).limit(1);

  const body: GroupsDTO = {
    groups: groups.map((g) => ({ ...g, lastMessageAt: g.lastMessageAt?.toISOString() ?? null })),
    untrackedPeople,
    transport: worker?.transport ?? null,
  };
  return json(body);
});
