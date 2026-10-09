import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MODELS, type ModelTier } from "@agent-city/core";

export type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.BetaMessage;
export type MessageParam = Anthropic.Beta.BetaMessageParam;

/** The one call the runtime makes. Injected so runs are testable without the API. */
export interface ModelClient {
  create(params: CreateParams, options?: { signal?: AbortSignal }): Promise<ModelMessage>;
}

/**
 * Production client. The SDK retries 408/409/429/5xx and connection errors with
 * exponential backoff (honouring retry-after), so transient API errors are
 * retried at the call level without repeating earlier tool calls.
 */
export function anthropicModelClient(client?: Anthropic): ModelClient {
  const anthropic = client ?? new Anthropic({ maxRetries: 4, timeout: 5 * 60 * 1000 });
  return {
    create: (params, options) => anthropic.beta.messages.create(params, options),
  };
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Refusal fallbacks: on a safety-classifier decline the API re-runs the request
 * on Anthropic's recommended model for that category, inside the same call.
 * Opted in by default for the Opus/Sonnet tiers; Haiku has no server-side
 * fallback. Set MODEL_FALLBACKS=off to disable.
 */
function fallbacksFor(model: string): Pick<CreateParams, "betas" | "fallbacks"> {
  if (process.env.MODEL_FALLBACKS === "off") return {};
  if (!/^claude-(opus|sonnet|fable)/.test(model)) return {};
  return { betas: [FALLBACK_BETA], fallbacks: "default" };
}

export interface RequestShape {
  tier: ModelTier;
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: MessageParam[];
  maxTokens?: number;
}

/**
 * Builds a Messages API request. Thinking is left at the model default
 * (adaptive; it cannot be disabled on these models) and effort is set
 * explicitly per tier. The system prompt carries a cache breakpoint (tools +
 * system are identical across an agent's runs) and top-level automatic caching
 * caches the growing conversation between steps.
 */
export function buildRequest(shape: RequestShape): CreateParams {
  const model = MODELS[shape.tier];
  return {
    model,
    max_tokens: shape.maxTokens ?? 16_000,
    system: [{ type: "text", text: shape.system, cache_control: { type: "ephemeral" } }],
    tools: shape.tools.length > 0 ? shape.tools : undefined,
    messages: shape.messages,
    output_config: { effort: EFFORT[shape.tier] },
    cache_control: { type: "ephemeral" },
    ...fallbacksFor(model),
  };
}

export function textOf(message: ModelMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
