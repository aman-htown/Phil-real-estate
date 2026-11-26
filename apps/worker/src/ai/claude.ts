import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { buildRequest, type PromptInput } from "./prompt";

/** Structured output Claude returns for every conversation turn. */
export const ReplyDecision = z.object({
  action: z
    .enum(["reply", "no_reply", "escalate"])
    .describe("reply = send a message; no_reply = nothing needs saying; escalate = a person must handle it"),
  reply: z
    .string()
    .describe("Exact WhatsApp message to send. For escalate, an optional holding message. Empty for no_reply."),
  operator_note: z
    .string()
    .describe("One or two sentences for the business's team: why this action, what to verify or follow up."),
  intent: z
    .string()
    .describe("2-5 word label for what the contact wants, e.g. 'viewing request', 'rental inquiry', 'sell valuation'."),
  urgency: z.enum(["low", "normal", "high"]),
  summary: z
    .string()
    .describe(
      "Updated 1-3 sentence summary of the whole conversation, keeping key facts (needs, budget, area, property, dates, next step).",
    ),
});
export type ReplyDecision = z.infer<typeof ReplyDecision>;

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). Haiku has none. */
function supportsFallbacks(model: string): boolean {
  return /^claude-(opus|sonnet|fable|mythos)-5/.test(model);
}

export class ClaudeRefusalError extends Error {}

export interface GenerationResult {
  decision: ReplyDecision;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  // Reads ANTHROPIC_API_KEY from the environment. Retries 429/5xx twice by default.
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export async function generateReply(input: PromptInput): Promise<GenerationResult> {
  const { settings } = input;
  const { system, messages } = buildRequest(input);
  const fallback = supportsFallbacks(settings.model);
  const started = Date.now();

  const response = await getClient().beta.messages.parse({
    model: settings.model,
    max_tokens: 16000,
    system,
    messages,
    output_config: {
      effort: settings.effort as "low" | "medium" | "high" | "xhigh" | "max",
      format: betaZodOutputFormat(ReplyDecision),
    },
    // If the model declines for policy reasons, retry server-side on Anthropic's recommended fallback model.
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new ClaudeRefusalError(`Claude declined to draft a reply${category ? ` (${category})` : ""}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens before finishing the reply");
  }
  const decision = response.parsed_output;
  if (!decision) throw new Error("Claude returned no parseable reply");

  return {
    decision,
    model: response.model,
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}
