import { z } from "zod";
import { approveDraft } from "@phil/core";
import { currentSession, db, handler, HttpError, json, parseBody } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ body: z.string().trim().min(1).max(4096).optional() });

/** Approve a draft (optionally with edited text) and queue it for sending. */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { body } = await parseBody(req, Body);
  const session = await currentSession();
  try {
    return json(await approveDraft(db(), id, { body, author: session?.name ?? null }), { status: 201 });
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : "Could not send draft");
  }
});
