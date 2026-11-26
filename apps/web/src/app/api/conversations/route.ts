import { asc } from "drizzle-orm";
import { z } from "zod";
import { openConversation, startConversation, waIdForPhone, workerStatus } from "@phil/core";
import { LIST_FILTERS, listConversations, type ListFilter } from "@/lib/queries";
import { db, handler, HttpError, json, parseBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const f = url.searchParams.get("filter") ?? "open";
  const filter: ListFilter = (LIST_FILTERS as readonly string[]).includes(f) ? (f as ListFilter) : "open";
  return json(await listConversations(db(), filter, url.searchParams.get("q") ?? ""));
});

const Start = z.union([
  /** Open (or create) the private chat with a known contact, e.g. a group member. */
  z.object({ contactId: z.string().uuid() }),
  /** Start a chat with a phone number that hasn't written in. */
  z.object({
    phone: z
      .string()
      .trim()
      .transform((v) => v.replace(/[^\d]/g, ""))
      .pipe(z.string().min(6, "Enter the full number with country code")),
    name: z.string().trim().max(120).optional(),
  }),
]);

export const POST = handler(async (req: Request) => {
  const body = await parseBody(req, Start);
  try {
    if ("contactId" in body) return json({ id: await openConversation(db(), body.contactId) });
    const [worker] = await db().select({ transport: workerStatus.transport }).from(workerStatus).orderBy(asc(workerStatus.id)).limit(1);
    const id = await startConversation(db(), {
      waId: waIdForPhone(worker?.transport, body.phone),
      phone: body.phone,
      name: body.name ?? null,
    });
    return json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === "Contact not found") throw new HttpError(404, err.message);
    throw err;
  }
});
