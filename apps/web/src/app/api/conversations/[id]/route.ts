import { eq } from "drizzle-orm";
import { z } from "zod";
import { conversations } from "@phil/core";
import { getConversationDetail } from "@/lib/queries";
import { db, handler, HttpError, json, parseBody } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const detail = await getConversationDetail(db(), id);
  if (!detail) throw new HttpError(404, "Conversation not found");
  return json(detail);
});

const Patch = z.object({
  /** null = follow the default mode from Settings */
  mode: z.enum(["auto", "draft", "off"]).nullable().optional(),
  status: z.enum(["open", "archived"]).optional(),
  /** Groups: reply in the group ("chat") or privately to whoever wrote ("sender"). */
  replyTarget: z.enum(["chat", "sender"]).optional(),
  needsAttention: z.literal(false).optional(),
  markRead: z.literal(true).optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(req, Patch);
  const set: Partial<typeof conversations.$inferInsert> = {};
  if (body.mode !== undefined) {
    set.mode = body.mode;
    // Turning the assistant off cancels a scheduled reply.
    if (body.mode === "off") set.pendingReplyAt = null;
  }
  if (body.status) set.status = body.status;
  if (body.replyTarget) set.replyTarget = body.replyTarget;
  if (body.needsAttention === false) {
    set.needsAttention = false;
    set.attentionReason = null;
  }
  if (body.markRead) set.unreadCount = 0;
  if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update");
  const [row] = await db().update(conversations).set(set).where(eq(conversations.id, id)).returning();
  if (!row) throw new HttpError(404, "Conversation not found");
  return json({ ok: true });
});
