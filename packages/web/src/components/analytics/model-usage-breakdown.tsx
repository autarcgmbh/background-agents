"use client";

import type { AnalyticsComputedCost } from "@open-inspect/shared/types/analytics";
import { UNATTRIBUTED_MODEL_ID } from "@open-inspect/shared/model-pricing";
import { formatAnalyticsCount } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

/** `anthropic/claude-opus-5` reads as "Claude Opus 5" in a dense table. */
export function formatModelLabel(modelId: string): string {
  if (modelId === UNATTRIBUTED_MODEL_ID) return "Unattributed";
  const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  return bare
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/**
 * Where a bucket's tokens went, per model.
 *
 * Splitting input from cached and output tokens is the point: cache reads cost
 * a tenth of input and output several times more, so one total cannot say
 * whether a session was expensive or merely cache-heavy.
 */
export function ModelUsageBreakdown({ cost }: { cost: AnalyticsComputedCost }) {
  if (!cost.models.length) return null;

  return (
    <div className="rounded-md border border-border-muted bg-background/60 p-3">
      <table className="min-w-full text-xs tabular-nums">
        <thead>
          <tr className="text-left text-secondary-foreground">
            <th className="py-1 pr-4 font-medium">Model</th>
            <th className="py-1 pr-4 text-right font-medium">Input</th>
            <th className="py-1 pr-4 text-right font-medium">Output</th>
            <th className="py-1 pr-4 text-right font-medium">Cache read</th>
            <th className="py-1 pr-4 text-right font-medium">Cache write</th>
            <th className="py-1 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {cost.models.map((model) => (
            <tr key={model.modelId} className="border-t border-border-muted/60">
              <td className="py-1.5 pr-4 font-medium text-foreground">
                {formatModelLabel(model.modelId)}
              </td>
              <td className="py-1.5 pr-4 text-right">{formatAnalyticsCount(model.inputTokens)}</td>
              <td className="py-1.5 pr-4 text-right">{formatAnalyticsCount(model.outputTokens)}</td>
              <td className="py-1.5 pr-4 text-right">
                {formatAnalyticsCount(model.cacheReadTokens)}
              </td>
              <td className="py-1.5 pr-4 text-right">
                {formatAnalyticsCount(model.cacheWriteTokens)}
              </td>
              <td className="py-1.5 text-right">
                {model.costUsd === null ? (
                  <span className="text-muted-foreground">No list price</span>
                ) : (
                  formatSessionCost(model.costUsd)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cost.hasUnpricedModels && (
        <p className="mt-2 text-xs text-muted-foreground">
          Some tokens ran on a model with no list price, so the total is a lower bound.
        </p>
      )}
    </div>
  );
}
