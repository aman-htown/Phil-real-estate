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
});

/**
 * Inject an inbound message as if a contact had sent it. For testing the
 * pipeline (especially with WHATSAPP_TRANSPORT=mock). Replies to simulated
 * contacts are sent through whatever transport the worker runs, so only use
 * real phone numbers you own when the worker is connected to WhatsApp.
 */
export const POST = handler(async (req: Request) => {
  const { phone, name, body } = await parseBody(req, Body);
  const result = await ingestInbound(db(), {
    waId: phone,
    phone,
    profileName: name || null,
    waMessageId: `sim-${randomUUID()}`,
    type: "text",
    body,
    timestamp: new Date(),
    meta: { simulated: true },
  });
  return json(result, { status: 201 });
});
