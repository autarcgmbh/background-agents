/**
 * Per-token list prices, and the cost of a session's reported token usage.
 *
 * Why this exists: a session running on a *subscription seat* (a connected
 * Claude or ChatGPT account) is never charged per request, so the runtime
 * reports a cost of zero for it. That is accurate billing and useless
 * analytics — it makes an expensive thread indistinguishable from a trivial
 * one. Pricing the reported tokens ourselves gives every session a comparable
 * number regardless of how it was paid for.
 *
 * The result is therefore a *list-price valuation of the tokens spent*, not an
 * invoice. On a seat nobody is billed it; on an API key it approximates the
 * real charge but ignores discounts, batch rates and priority tiers.
 */

/** List prices in USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Reading a cached prefix; far cheaper than re-sending it as input. */
  cacheRead: number;
  /** Writing a prefix into the cache; a premium over plain input. */
  cacheWrite: number;
}

/**
 * Anthropic's standard cache multipliers, applied to a model's input rate:
 * a cache write costs a premium over input, a cache read a small fraction.
 * Models that price cache reads differently state the rate outright.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function anthropic(input: number, output: number, cacheRead?: number): ModelPricing {
  return {
    input,
    output,
    cacheRead: cacheRead ?? input * CACHE_READ_MULTIPLIER,
    cacheWrite: input * CACHE_WRITE_MULTIPLIER,
  };
}

/**
 * OpenAI quotes cached input outright rather than as a multiple of input, so
 * `cacheRead` is passed explicitly. Cache writes carry the same 1.25x premium
 * as Anthropic's, and like Anthropic's they replace the input rate for those
 * tokens rather than adding to it.
 */
function openai(input: number, output: number, cacheRead: number): ModelPricing {
  return { input, output, cacheRead, cacheWrite: input * CACHE_WRITE_MULTIPLIER };
}

/**
 * Keyed by the catalog model id (`provider/model`).
 *
 * Deliberately partial. A model is listed only where we hold a published rate;
 * anything absent is reported as unpriced rather than valued at a guess, so a
 * missing row understates the fleet total but never invents one. Extend it as
 * rates are confirmed — see `MODEL_CATALOG` for the ids in use.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // Anthropic first-party API rates. Fable prices cache reads at a flat
  // $0.25/MTok rather than the usual tenth of input.
  "anthropic/claude-fable-5-1": anthropic(10, 50, 0.25),
  "anthropic/claude-fable-5": anthropic(10, 50, 0.25),
  "anthropic/claude-opus-5": anthropic(5, 25),
  "anthropic/claude-opus-4-8": anthropic(5, 25),
  "anthropic/claude-opus-4-7": anthropic(5, 25),
  "anthropic/claude-opus-4-6": anthropic(5, 25),
  "anthropic/claude-sonnet-5": anthropic(2, 10),
  "anthropic/claude-sonnet-4-6": anthropic(3, 15),
  "anthropic/claude-haiku-4-5": anthropic(1, 5),

  // OpenAI standard processing rates. gpt-5.3-codex-spark is deliberately
  // absent: it is in our catalog but not on OpenAI's pricing page, so it stays
  // unpriced until a rate is published.
  //
  // GPT-6 Astra also has a long-context tier — a request over 272K input
  // tokens is billed at $20/$75 rather than $10/$50. Not modelled here: the
  // per-request token counts that tier depends on are not retained, so a
  // session that crossed it is valued slightly low.
  "openai/gpt-6-astra": openai(10, 50, 1),
  "openai/gpt-5.6-sol": openai(4, 20, 0.4),
  "openai/gpt-5.6-terra": openai(2, 12, 0.2),
  "openai/gpt-5.6-luna": openai(0.2, 1.2, 0.02),
  "openai/gpt-5.5": openai(5, 30, 0.5),
  "openai/gpt-5.4": openai(2.5, 15, 0.25),
  "openai/gpt-5.3-codex": openai(1.75, 14, 0.175),
};

/**
 * Bucket for usage no model can be attributed to: an older runtime that sent
 * no model id, or a total the provider reported without a component split.
 * Never priced — usage lands here precisely when it cannot be valued, so a
 * rollup containing it reports its cost as a lower bound.
 */
export const UNATTRIBUTED_MODEL_ID = "unattributed";

/** Token counts for one model, as the runtimes report them. */
export interface ModelTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Thinking tokens. Reported separately by OpenCode but already counted
   * within `output` by the providers that bill them, so this is carried for
   * display and deliberately not priced again — see `usageCostUsd`.
   */
  reasoning: number;
}

export const EMPTY_MODEL_TOKEN_USAGE: ModelTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

/** Every token the usage accounts for, including cached and reasoning tokens. */
export function totalTokens(usage: ModelTokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function pricingFor(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] ?? null;
}

/**
 * List-price value of `usage` on `modelId`, or null when the model has no
 * published rate. Null is not zero: it means "we cannot say", and a caller
 * showing a fleet total must say so rather than silently adding nothing.
 *
 * Reasoning tokens are not charged separately — providers that report them
 * also count them inside `output`, so pricing both would double-bill thinking.
 */
export function usageCostUsd(usage: ModelTokenUsage, modelId: string): number | null {
  const pricing = pricingFor(modelId);
  if (!pricing) return null;
  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) /
    1_000_000
  );
}

/** One model's contribution to a session, priced. */
export interface ModelUsageCost {
  modelId: string;
  usage: ModelTokenUsage;
  totalTokens: number;
  /** Null when `modelId` has no published rate. */
  costUsd: number | null;
}

export interface UsageCostRollup {
  /** Per model, most expensive first; unpriced models sort last. */
  models: ModelUsageCost[];
  totalTokens: number;
  /** Σ of the priced models. Zero when every model is unpriced. */
  costUsd: number;
  /** True when at least one model had no rate, so `costUsd` is a lower bound. */
  hasUnpricedModels: boolean;
}

export function rollupUsageCost(byModel: Iterable<[string, ModelTokenUsage]>): UsageCostRollup {
  const models: ModelUsageCost[] = [];
  let costUsd = 0;
  let tokens = 0;
  let hasUnpricedModels = false;
  for (const [modelId, usage] of byModel) {
    const cost = usageCostUsd(usage, modelId);
    const modelTokens = totalTokens(usage);
    tokens += modelTokens;
    if (cost === null) hasUnpricedModels = true;
    else costUsd += cost;
    models.push({ modelId, usage, totalTokens: modelTokens, costUsd: cost });
  }
  models.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.totalTokens - a.totalTokens);
  return { models, totalTokens: tokens, costUsd, hasUnpricedModels };
}
