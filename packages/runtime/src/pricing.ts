import { computeCostUsd, DEFAULT_MODEL_PRICING, type ModelPricingRow } from "@agent-city/core";
import type { Repo } from "@agent-city/db";
import type { ModelMessage } from "./model";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export const emptyUsage = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
});

/** Pricing from the model_pricing table (spec §9), falling back to the defaults in core. */
export class PriceBook {
  private cache = new Map<string, ModelPricingRow>();

  constructor(private readonly repo: Repo) {}

  async get(model: string): Promise<ModelPricingRow> {
    const cached = this.cache.get(model);
    if (cached) return cached;
    let row: ModelPricingRow | null = null;
    try {
      row = await this.repo.getModelPricing(model);
    } catch {
      row = null;
    }
    const resolved =
      row ??
      DEFAULT_MODEL_PRICING.find((p) => p.model === model) ??
      // Unknown model: price it like the most expensive default so budgets stay safe.
      DEFAULT_MODEL_PRICING.reduce((a, b) => (a.output_per_mtok >= b.output_per_mtok ? a : b));
    this.cache.set(model, resolved);
    return resolved;
  }

  /**
   * Cost of one response. With refusal fallbacks, `usage.iterations` holds one
   * entry per attempt (each billed at its own model's rates) and is the source
   * of truth; otherwise the top-level usage applies to the served model.
   */
  async costOf(message: ModelMessage, requestedModel: string): Promise<UsageTotals> {
    const usage = message.usage;
    const parts =
      usage.iterations && usage.iterations.length > 0
        ? usage.iterations.map((it) => ({ model: ("model" in it && it.model) || requestedModel, usage: it }))
        : [{ model: message.model || requestedModel, usage }];

    const totals = emptyUsage();
    for (const part of parts) {
      const u = part.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
      };
      const normalized = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_creation: u.cache_creation ?? null,
      };
      totals.input_tokens += normalized.input_tokens;
      totals.output_tokens += normalized.output_tokens;
      totals.cache_read_tokens += normalized.cache_read_input_tokens;
      totals.cache_write_tokens += normalized.cache_creation_input_tokens;
      totals.cost_usd += computeCostUsd(await this.get(part.model), normalized);
    }
    return totals;
  }
}

export function addUsage(into: UsageTotals, more: UsageTotals): void {
  into.input_tokens += more.input_tokens;
  into.output_tokens += more.output_tokens;
  into.cache_read_tokens += more.cache_read_tokens;
  into.cache_write_tokens += more.cache_write_tokens;
  into.cost_usd += more.cost_usd;
}
