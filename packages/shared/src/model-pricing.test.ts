import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "./models";
import {
  EMPTY_MODEL_TOKEN_USAGE,
  MODEL_PRICING,
  UNATTRIBUTED_MODEL_ID,
  pricingFor,
  rollupUsageCost,
  totalTokens,
  usageCostUsd,
  type ModelTokenUsage,
} from "./model-pricing";

function usage(overrides: Partial<ModelTokenUsage> = {}): ModelTokenUsage {
  return { ...EMPTY_MODEL_TOKEN_USAGE, ...overrides };
}

describe("model pricing", () => {
  it("prices a million input tokens at the model's list rate", () => {
    expect(usageCostUsd(usage({ input: 1_000_000 }), "anthropic/claude-opus-5")).toBe(5);
    expect(usageCostUsd(usage({ output: 1_000_000 }), "anthropic/claude-opus-5")).toBe(25);
  });

  it("charges cache reads a tenth of input and writes a premium", () => {
    expect(usageCostUsd(usage({ cacheRead: 1_000_000 }), "anthropic/claude-opus-5")).toBeCloseTo(
      0.5
    );
    expect(usageCostUsd(usage({ cacheWrite: 1_000_000 }), "anthropic/claude-opus-5")).toBeCloseTo(
      6.25
    );
  });

  it("uses Fable's flat cache-read rate rather than a tenth of input", () => {
    expect(usageCostUsd(usage({ cacheRead: 1_000_000 }), "anthropic/claude-fable-5-1")).toBeCloseTo(
      0.25
    );
  });

  it("does not bill reasoning tokens, which output already counts", () => {
    const withReasoning = usage({ output: 1_000, reasoning: 900 });
    const withoutReasoning = usage({ output: 1_000 });
    expect(usageCostUsd(withReasoning, "anthropic/claude-opus-5")).toBe(
      usageCostUsd(withoutReasoning, "anthropic/claude-opus-5")
    );
  });

  it("reports an unpriced model as null, which is not zero", () => {
    expect(pricingFor("opencode/glm-5")).toBeNull();
    expect(usageCostUsd(usage({ input: 10_000_000 }), "opencode/glm-5")).toBeNull();
  });

  it("counts cached tokens in the token total even though they cost less", () => {
    expect(totalTokens(usage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }))).toBe(100);
  });

  describe("rollup", () => {
    it("sums priced models and flags that unpriced ones are missing", () => {
      const rollup = rollupUsageCost([
        ["anthropic/claude-opus-5", usage({ input: 1_000_000 })],
        ["opencode/glm-5", usage({ input: 1_000_000 })],
      ]);
      expect(rollup.costUsd).toBe(5);
      expect(rollup.hasUnpricedModels).toBe(true);
      expect(rollup.totalTokens).toBe(2_000_000);
    });

    it("orders by cost so the expensive model reads first, unpriced last", () => {
      const rollup = rollupUsageCost([
        ["opencode/glm-5", usage({ input: 5_000_000 })],
        ["anthropic/claude-haiku-4-5", usage({ input: 1_000_000 })],
        ["anthropic/claude-opus-5", usage({ input: 1_000_000 })],
      ]);
      expect(rollup.models.map((entry) => entry.modelId)).toEqual([
        "anthropic/claude-opus-5",
        "anthropic/claude-haiku-4-5",
        "opencode/glm-5",
      ]);
    });

    it("reports zero cost, not a false total, when nothing is priced", () => {
      const rollup = rollupUsageCost([["opencode/glm-5", usage({ input: 1_000_000 })]]);
      expect(rollup.costUsd).toBe(0);
      expect(rollup.hasUnpricedModels).toBe(true);
    });

    it("is empty for a session that reported no usage", () => {
      expect(rollupUsageCost([])).toEqual({
        models: [],
        totalTokens: 0,
        costUsd: 0,
        hasUnpricedModels: false,
      });
    });
  });

  it("never prices the unattributed bucket, so its tokens stay a lower bound", () => {
    expect(pricingFor(UNATTRIBUTED_MODEL_ID)).toBeNull();
    const rollup = rollupUsageCost([[UNATTRIBUTED_MODEL_ID, usage({ input: 1_000_000 })]]);
    expect(rollup.costUsd).toBe(0);
    expect(rollup.hasUnpricedModels).toBe(true);
    expect(rollup.totalTokens).toBe(1_000_000);
  });

  it("prices only ids the catalog actually offers, so no row is dead", () => {
    const catalogIds = new Set(
      MODEL_CATALOG.flatMap((group) => group.models.map((model) => model.id))
    );
    for (const id of Object.keys(MODEL_PRICING)) {
      expect(catalogIds.has(id), `${id} is priced but absent from the catalog`).toBe(true);
    }
  });
});
