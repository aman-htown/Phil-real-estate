import { requestReply } from "@phil/core";
import { db, handler, json } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

/** Ask the worker to draft (or re-draft) a reply now. Always produces a draft, never an auto-send. */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requestReply(db(), id);
  return json({ ok: true });
});
