import { z } from "zod";
import { EFFORT_OPTIONS, getSettings, MODEL_OPTIONS, updateSettings } from "@phil/core";
import { db, handler, json, parseBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async () => json(await getSettings(db())));

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const Body = z
  .object({
    businessName: z.string().trim().min(1).max(120),
    systemPrompt: z.string().trim().min(1).max(50_000),
    model: z.enum(MODEL_OPTIONS.map((m) => m.id) as [string, ...string[]]),
    effort: z.enum(EFFORT_OPTIONS),
    defaultMode: z.enum(["auto", "draft", "off"]),
    autoSendEnabled: z.boolean(),
    debounceSeconds: z.number().int().min(0).max(600),
    historyLimit: z.number().int().min(4).max(200),
    timezone: z.string().refine(validTimeZone, "Unknown time zone"),
  })
  .partial();

export const PUT = handler(async (req: Request) => {
  const patch = await parseBody(req, Body);
  return json(await updateSettings(db(), patch));
});
