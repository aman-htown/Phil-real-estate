import { asc } from "drizzle-orm";
import { z } from "zod";
import { knowledgeEntries } from "@phil/core";
import { db, handler, json, parseBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async () =>
  json(await db().select().from(knowledgeEntries).orderBy(asc(knowledgeEntries.sortOrder), asc(knowledgeEntries.createdAt))),
);

const Body = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(100_000),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const POST = handler(async (req: Request) => {
  const body = await parseBody(req, Body);
  const [row] = await db().insert(knowledgeEntries).values(body).returning();
  return json(row, { status: 201 });
});
