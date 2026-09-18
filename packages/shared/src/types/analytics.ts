import type { SpawnSource } from "./sessions";

export const ANALYTICS_DAYS = [7, 14, 30, 90] as const;
export type AnalyticsDays = (typeof ANALYTICS_DAYS)[number];

export const ANALYTICS_BREAKDOWN_BY = ["user", "repo", "session"] as const;
export type AnalyticsBreakdownBy = (typeof ANALYTICS_BREAKDOWN_BY)[number];

export interface AnalyticsStatusBreakdown {
  created: number;
  active: number;
  completed: number;
  failed: number;
  archived: number;
  cancelled: number;
}

export interface AnalyticsSummaryResponse {
  totalSessions: number;
  activeUsers: number;
  /** Cost the providers reported. Zero for sessions billed to a seat. */
  totalCost: number;
  avgCost: number;
  /** List-price value of every session's tokens in the window. */
  computedCost?: AnalyticsComputedCost;
  totalPrs: number;
  statusBreakdown: AnalyticsStatusBreakdown;
}

export interface AnalyticsTimeseriesPoint {
  date: string;
  groups: Record<string, number>;
}

export interface AnalyticsTimeseriesResponse {
  series: AnalyticsTimeseriesPoint[];
}

/** One model's share of a bucket's token spend, priced at list rates. */
export interface AnalyticsModelUsageEntry {
  /** Catalog id, or `unattributed` for usage no model could be attributed to. */
  modelId: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the model has no published rate. */
  costUsd: number | null;
}

/**
 * What a bucket's reported tokens are worth at list prices.
 *
 * This is not an invoice. Sessions on a subscription seat are never billed
 * per request, so the provider reports no cost for them; valuing their tokens
 * is the only way to compare them against API-billed work.
 */
export interface AnalyticsComputedCost {
  /** Σ of the priced models. A lower bound when `hasUnpricedModels` is set. */
  costUsd: number;
  /** True when some usage ran on a model with no published rate. */
  hasUnpricedModels: boolean;
  /** Per model, most expensive first. */
  models: AnalyticsModelUsageEntry[];
}

export interface AnalyticsBreakdownEntry {
  key: string;
  displayName?: string;
  /** Present for session breakdowns. */
  repository?: string | null;
  user?: string;
  status?: string;
  /** Null when usage has not been reported; omitted by older servers. */
  totalTokens?: number | null;
  /**
   * List-price value of this bucket's tokens. Absent when the bucket reported
   * no usage at all, which is different from a computed cost of zero.
   */
  computedCost?: AnalyticsComputedCost;
  sessions: number;
  completed: number;
  failed: number;
  cancelled: number;
  cost: number;
  prs: number;
  messageCount: number;
  avgDuration: number;
  lastActive: number;
}

export interface AnalyticsBreakdownResponse {
  entries: AnalyticsBreakdownEntry[];
}

// ─── Pull-request analytics ──────────────────────────────────────────────────
//
// PR-scoped by design (docs/pr-analytics-design.md §2): sessions serve many
// non-PR use-cases, so every metric here is conditioned on "given a PR exists"
// — numerators and denominators both come from session_pull_requests, and
// sessions/users/repos are join dimensions only. Unlike the session analytics,
// no spawn-source filter: automation-produced PRs are output too.

/** Outcome mix of the PRs created in the window (open PRs are still-open, not failures). */
export interface AnalyticsPullRequestFunnel {
  created: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
}

export interface AnalyticsPullRequestTimeseriesPoint {
  date: string;
  /** PRs created that day (bucketed by provider creation time). */
  created: number;
  /** PRs merged that day (bucketed by merged_at). */
  merged: number;
}

export interface AnalyticsPullRequestRepoEntry {
  /** owner/name of the repository the PR lives in. */
  key: string;
  created: number;
  merged: number;
  closed: number;
  /** Mean open→merge duration over this repo's cohort PRs; null when none merged. */
  avgTimeToMergeMs: number | null;
}

export interface AnalyticsPullRequestSourceEntry {
  /** The producing session's spawn_source. */
  source: SpawnSource;
  created: number;
  merged: number;
}

export interface AnalyticsPullRequestsResponse {
  funnel: AnalyticsPullRequestFunnel;
  /**
   * Σ total_cost of sessions that produced ≥1 cohort PR — the cost basis for
   * cost-per-merged-PR. Never platform-wide cost: non-PR sessions are out of
   * scope by the PR-analytics scoping rule.
   */
  prSessionCost: number;
  /** PRs whose merged_at falls in the window (regardless of creation cohort). */
  mergedInWindow: number;
  /** Mean open→merge duration of those merges; null when none. */
  avgTimeToMergeMs: number | null;
  /** Open PRs as of now (not windowed) — work-in-progress inventory. */
  openInventory: {
    total: number;
    avgAgeMs: number | null;
  };
  timeseries: AnalyticsPullRequestTimeseriesPoint[];
  repos: AnalyticsPullRequestRepoEntry[];
  sources: AnalyticsPullRequestSourceEntry[];
}

/** One coherently-windowed analytics dashboard snapshot. */
export interface AnalyticsDashboardResponse {
  /** Request time used to anchor the window and open-PR age calculations. */
  generatedAt: number;
  /** Half-open interval [startAt, endAt) shared by every windowed metric. */
  window: {
    days: AnalyticsDays;
    startAt: number;
    endAt: number;
  };
  summary: AnalyticsSummaryResponse;
  timeseries: AnalyticsTimeseriesResponse;
  breakdowns: {
    repository: AnalyticsBreakdownResponse;
    user: AnalyticsBreakdownResponse;
    session: AnalyticsBreakdownResponse;
  };
  pullRequests: AnalyticsPullRequestsResponse;
}
