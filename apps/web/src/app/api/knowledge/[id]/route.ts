import { eq } from "drizzle-orm";
import { z } from "zod";
import { knowledgeEntries } from "@phil/core";
import { db, handler, HttpError, json, parseBody } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
const Body = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(100_000),
    enabled: z.boolean(),
    sortOrder: z.number().int(),
  })
  .partial();

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(req, Body);
  const [row] = await db().update(knowledgeEntries).set(body).where(eq(knowledgeEntries.id, id)).returning();
  if (!row) throw new HttpError(404, "Entry not found");
  return json(row);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const [row] = await db().delete(knowledgeEntries).where(eq(knowledgeEntries.id, id)).returning();
  if (!row) throw new HttpError(404, "Entry not found");
  return json({ ok: true });
});
