import { eq } from "drizzle-orm";
import { z } from "zod";
import { contacts, setTracked } from "@phil/core";
import { db, handler, HttpError, json, parseBody } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  /** false = stop capturing this chat and DELETE its stored messages. */
  tracked: z.boolean().optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(req, Body);
  if (body.tracked !== undefined) {
    try {
      return json(await setTracked(db(), id, body.tracked));
    } catch (err) {
      throw new HttpError(404, err instanceof Error ? err.message : "Contact not found");
    }
  }
  const set = {
    ...(body.displayName !== undefined ? { displayName: body.displayName || null } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.tags !== undefined ? { tags: Array.from(new Set(body.tags)) } : {}),
  };
  if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update");
  const [row] = await db().update(contacts).set(set).where(eq(contacts.id, id)).returning();
  if (!row) throw new HttpError(404, "Contact not found");
  return json(row);
});
