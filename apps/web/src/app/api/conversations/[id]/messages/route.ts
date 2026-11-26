import { eq } from "drizzle-orm";
import { z } from "zod";
import { conversations, queueOutbound } from "@phil/core";
import { currentSession, db, handler, HttpError, json, parseBody } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ body: z.string().trim().min(1).max(4096) });

/** Send a message typed by a human. */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { body } = await parseBody(req, Body);
  const session = await currentSession();
  const [conv] = await db().select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id));
  if (!conv) throw new HttpError(404, "Conversation not found");
  const message = await queueOutbound(db(), { conversationId: id, body, source: "human", author: session?.name ?? null });
  return json(message, { status: 201 });
});
