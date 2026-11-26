import { LIST_FILTERS, listConversations, type ListFilter } from "@/lib/queries";
import { db, handler, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const f = url.searchParams.get("filter") ?? "open";
  const filter: ListFilter = (LIST_FILTERS as readonly string[]).includes(f) ? (f as ListFilter) : "open";
  return json(await listConversations(db(), filter, url.searchParams.get("q") ?? ""));
});
