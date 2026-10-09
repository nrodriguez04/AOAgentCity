import type { ModelTier } from "./enums";
import type { ModelPricingRow } from "./rows";

// Model IDs live in config, not code (spec §3). Reading process.env is guarded so
// this module stays safe to import from the browser bundle.
const env = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[key] || undefined : undefined;

export const MODELS: Record<ModelTier, string> = {
  reasoning: env("MODEL_REASONING") ?? "claude-opus-5-5", // HQ, planning
  standard: env("MODEL_STANDARD") ?? "claude-sonnet-5-5", // most division work
  fast: env("MODEL_FAST") ?? "claude-haiku-5-5", // triage, classification
};

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

function effortFromEnv(key: string, fallback: Effort): Effort {
  const value = env(key);
  return (EFFORT_LEVELS as readonly string[]).includes(value ?? "") ? (value as Effort) : fallback;
}

// Thinking is always on for these models; effort is the control for depth, cost
// and latency. Defaults are a starting point: tune per agent on real runs.
export const EFFORT: Record<ModelTier, Effort> = {
  reasoning: effortFromEnv("EFFORT_REASONING", "high"),
  standard: effortFromEnv("EFFORT_STANDARD", "medium"),
  fast: effortFromEnv("EFFORT_FAST", "low"),
};

/**
 * Default list prices in USD per million tokens. The runtime reads pricing from
 * the `model_pricing` table (seeded from this list) and falls back to it.
 * Fallback targets are included because server-side refusal fallbacks bill at
 * the fallback model's own rates.
 */
export const DEFAULT_MODEL_PRICING: ModelPricingRow[] = [
  price("claude-opus-5-5", 4, 20, 5, 8, 0.2),
  price("claude-sonnet-5-5", 2, 10, 2.5, 4, 0.2),
  {
    ...price("claude-haiku-5-5", 0.1, 0.5, 0.125, 0.2, 0.01),
    long_context_threshold: 100_000,
    long_input_per_mtok: 0.5,
    long_output_per_mtok: 2.5,
  },
  price("claude-opus-5", 5, 25, 6.25, 10, 0.5),
  price("claude-opus-4-8", 5, 25, 6.25, 10, 0.5),
];

function price(
  model: string,
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
): ModelPricingRow {
  return {
    model,
    input_per_mtok: input,
    output_per_mtok: output,
    cache_write_5m_per_mtok: cacheWrite5m,
    cache_write_1h_per_mtok: cacheWrite1h,
    cache_read_per_mtok: cacheRead,
    long_context_threshold: null,
    long_input_per_mtok: null,
    long_output_per_mtok: null,
  };
}

/** The subset of an API `usage` object that cost accounting needs. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

export function computeCostUsd(pricing: ModelPricingRow, usage: UsageLike): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    usage.cache_creation?.ephemeral_5m_input_tokens ??
    Math.max(0, (usage.cache_creation_input_tokens ?? 0) - write1h);
  const promptTokens = usage.input_tokens + cacheRead + write5m + write1h;

  const long =
    pricing.long_context_threshold !== null &&
    pricing.long_input_per_mtok !== null &&
    promptTokens > pricing.long_context_threshold;
  // Cache rates are multiples of the input rate, so they scale with it.
  const scale = long ? pricing.long_input_per_mtok! / pricing.input_per_mtok : 1;
  const inputRate = pricing.input_per_mtok * scale;
  const outputRate = long && pricing.long_output_per_mtok !== null ? pricing.long_output_per_mtok : pricing.output_per_mtok;

  const dollars =
    usage.input_tokens * inputRate +
    usage.output_tokens * outputRate +
    cacheRead * pricing.cache_read_per_mtok * scale +
    write5m * pricing.cache_write_5m_per_mtok * scale +
    write1h * pricing.cache_write_1h_per_mtok * scale;
  return dollars / 1_000_000;
}

/** Used by the budget check when an agent has no run history yet. */
export const DEFAULT_RUN_COST_ESTIMATE_USD: Record<ModelTier, number> = {
  reasoning: 0.6,
  standard: 0.2,
  fast: 0.02,
};
