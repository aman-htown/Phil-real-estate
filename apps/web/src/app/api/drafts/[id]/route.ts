import { z } from "zod";
import { updateDraftBody } from "@phil/core";
import { db, handler, HttpError, json, parseBody } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ body: z.string().max(4096) });

/** Save edits to a pending draft. */
export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { body } = await parseBody(req, Body);
  try {
    return json(await updateDraftBody(db(), id, body));
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : "Could not update draft");
  }
});
