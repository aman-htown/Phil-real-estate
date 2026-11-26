import { discardDraft } from "@phil/core";
import { db, handler, HttpError, json } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  try {
    return json(await discardDraft(db(), id));
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : "Could not discard draft");
  }
});
