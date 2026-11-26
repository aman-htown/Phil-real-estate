import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { appSettings, type AppSettings, type Conversation, type ConversationMode } from "./schema";

export const MODEL_OPTIONS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 (most capable, priciest)" },
] as const;

export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_OPTIONS)[number];

export const DEFAULT_SYSTEM_PROMPT = `You are the WhatsApp assistant for Phil, a real estate agent. You reply on Phil's behalf to buyers, sellers, tenants and landlords who message his WhatsApp.

How to write:
- Sound like a friendly, professional agent texting: short, warm, plain language. 1-4 short sentences is usually right. No markdown, no bullet lists unless the contact asks for details.
- Match the contact's language. If they write in Spanish, reply in Spanish.
- Use the contact's first name only if you know it.

What to do:
- Answer questions using the knowledge base (listings, fees, process, areas covered). If the answer is not in the knowledge base, do not guess: say you'll check with Phil and get back to them.
- For viewing requests, ask for 2-3 times that suit them; Phil confirms the slot.
- For new leads, find out what they need: buying/renting/selling, area, budget, bedrooms, timeline. Ask one or two questions at a time, not a form.
- Never commit to prices, offers, discounts, legal or mortgage advice, or anything contractual. Escalate those to Phil.`;

export const DEFAULT_SETTINGS: Omit<AppSettings, "updatedAt"> = {
  id: 1,
  businessName: "Phil Real Estate",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  model: "claude-opus-5-5",
  effort: "medium",
  defaultMode: "draft",
  autoSendEnabled: true,
  debounceSeconds: 20,
  historyLimit: 40,
  timezone: "UTC",
  autoTrackNewGroups: true,
  groupDefaultMode: "auto",
  groupReplyTarget: "sender",
};

/** Loads the settings row, creating it with defaults on first use. */
export async function getSettings(db: Database): Promise<AppSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (row) return row;
  const [created] = await db
    .insert(appSettings)
    .values(DEFAULT_SETTINGS)
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (!again) throw new Error("Could not load app settings");
  return again;
}

export async function updateSettings(
  db: Database,
  patch: Partial<Omit<AppSettings, "id" | "updatedAt">>,
): Promise<AppSettings> {
  await getSettings(db);
  const [row] = await db.update(appSettings).set(patch).where(eq(appSettings.id, 1)).returning();
  if (!row) throw new Error("Could not update app settings");
  return row;
}

/** The mode that actually applies to a conversation. */
export function effectiveMode(
  conversation: Pick<Conversation, "mode">,
  settings: Pick<AppSettings, "defaultMode">,
): ConversationMode {
  return conversation.mode ?? settings.defaultMode;
}
