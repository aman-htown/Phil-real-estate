import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ingestInbound } from "@phil/core";
import { db, handler, json, parseBody } from "@/lib/server";

const Body = z.object({
  phone: z
    .string()
    .trim()
    .transform((s) => s.replace(/[^\d]/g, ""))
    .pipe(z.string().min(6, "Enter a phone number")),
  name: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1).max(4096),
  /** Post the message in a (simulated) group with this name instead of a private chat. */
  group: z.string().trim().max(120).optional(),
  /** Simulate an @mention of the business in the group. */
  mentionsMe: z.boolean().optional(),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";

/**
 * Inject an inbound message as if a contact had sent it. For testing the
 * pipeline (especially with WHATSAPP_TRANSPORT=mock). Replies to simulated
 * contacts go through whatever transport the worker runs, so only use real
 * phone numbers you own when the worker is connected to WhatsApp.
 */
export const POST = handler(async (req: Request) => {
  const { phone, name, body, group, mentionsMe } = await parseBody(req, Body);
  const person = { waId: phone, phone, name: name || null };
  const result = await ingestInbound(db(), {
    chat: group ? { waId: `sim-${slug(group)}@g.us`, kind: "group", name: group } : { ...person, kind: "person" },
    sender: group ? person : undefined,
    mentionsMe: group ? mentionsMe : undefined,
    waMessageId: `sim-${randomUUID()}`,
    type: "text",
    body,
    timestamp: new Date(),
    meta: { simulated: true },
  });
  return json(result, { status: 201 });
});
