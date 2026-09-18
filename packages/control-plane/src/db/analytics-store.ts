import type {
  AnalyticsBreakdownBy,
  AnalyticsBreakdownEntry,
  AnalyticsBreakdownResponse,
  AnalyticsComputedCost,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared/types/analytics";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import {
  rollupUsageCost,
  type ModelTokenUsage,
  type UsageCostRollup,
} from "@open-inspect/shared/model-pricing";
import { MS_PER_DAY, utcDateFromDayIndex } from "./utc-day";
import { z } from "zod";

/** Spawn sources that represent direct human-initiated sessions. */
export const HUMAN_SPAWN_SOURCES: SpawnSource[] = ["user", "slack-bot", "linear-bot", "github-bot"];

const REPO_GROUP_EXPRESSION =
  "CASE WHEN s.repo_owner IS NULL OR s.repo_name IS NULL THEN NULL ELSE s.repo_owner || '/' || s.repo_name END";

export interface AnalyticsFilters {
  startAt: number;
  endAt: number;
  spawnSources?: SpawnSource[];
}

const summaryRowSchema = z.object({
  total_sessions: z.number(),
  active_users: z.number(),
  total_cost: z.number(),
  total_prs: z.number(),
  created_count: z.number(),
  active_count: z.number(),
  completed_count: z.number(),
  failed_count: z.number(),
  archived_count: z.number(),
  cancelled_count: z.number(),
});

type SummaryRow = z.infer<typeof summaryRowSchema>;

const timeseriesRowSchema = z.object({
  day_index: z.number(),
  group_key: z.string(),
  count: z.number(),
});

type TimeseriesRow = z.infer<typeof timeseriesRowSchema>;

const modelUsageRowSchema = z.object({
  key: z.string().nullable(),
  model_id: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  reasoning_tokens: z.number(),
});

const breakdownRowSchema = z.object({
  key: z.string().nullable(),
  display_name: z.string().nullable().optional(),
  total_tokens: z.number().nullable().optional(),
  repository: z.string().nullable().optional(),
  user_name: z.string().optional(),
  status: z.string().optional(),
  sessions: z.number(),
  completed: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  cost: z.number(),
  prs: z.number(),
  message_count: z.number(),
  avg_duration: z.number(),
  last_active: z.number(),
});

type BreakdownRow = z.infer<typeof breakdownRowSchema>;

const NO_REPOSITORY_ANALYTICS_KEY = "No repository";

export class AnalyticsStore {
  constructor(private readonly db: SqlDatabase) {}

  async getSummary(filters: AnalyticsFilters): Promise<AnalyticsSummaryResponse> {
    const result = await this.prepareSummary(filters).all<SummaryRow>();
    return this.decodeSummary(result);
  }

  prepareSummary(filters: AnalyticsFilters): SqlStatement {
    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");

    return this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_sessions,
           -- Uses user_id when available, falls back to scm_login for unlinked sessions.
           -- During the Phase 4→6 rollout window, the same person may appear under both
           -- keys (scm_login on old sessions, user_id on new), temporarily inflating this
           -- count. Resolves once the Phase 6 backfill populates user_id on historical rows.
           COUNT(DISTINCT COALESCE(user_id, NULLIF(scm_login, ''))) AS active_users,
           COALESCE(SUM(total_cost), 0) AS total_cost,
           COALESCE(SUM(pr_count), 0) AS total_prs,
           COALESCE(SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END), 0) AS created_count,
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_count,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
           COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived_count,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
         FROM sessions
         WHERE created_at >= ? AND created_at < ?
           AND spawn_source IN (${placeholders})`
      )
      .bind(filters.startAt, filters.endAt, ...sources);
  }

  decodeSummary(result: SqlResult): AnalyticsSummaryResponse {
    const row = parseOptionalRow(result.results?.[0], summaryRowSchema, "analytics summary row");

    const totalSessions = row?.total_sessions ?? 0;
    const totalCost = row?.total_cost ?? 0;

    return {
      totalSessions,
      activeUsers: row?.active_users ?? 0,
      totalCost,
      avgCost: totalSessions > 0 ? totalCost / totalSessions : 0,
      totalPrs: row?.total_prs ?? 0,
      statusBreakdown: {
        created: row?.created_count ?? 0,
        active: row?.active_count ?? 0,
        completed: row?.completed_count ?? 0,
        failed: row?.failed_count ?? 0,
        archived: row?.archived_count ?? 0,
        cancelled: row?.cancelled_count ?? 0,
      },
    };
  }

  async getTimeseries(filters: AnalyticsFilters): Promise<AnalyticsTimeseriesResponse> {
    const result = await this.prepareTimeseries(filters).all<TimeseriesRow>();
    return this.decodeTimeseries(result);
  }

  prepareTimeseries(filters: AnalyticsFilters): SqlStatement {
    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");

    return this.db
      .prepare(
        `SELECT
           s.created_at / ${MS_PER_DAY} AS day_index,
           COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), '__unknown__') AS group_key,
           COUNT(*) AS count
         FROM sessions s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.created_at >= ? AND s.created_at < ?
           AND s.spawn_source IN (${placeholders})
         GROUP BY day_index, COALESCE(s.user_id, '__unlinked__' || COALESCE(s.scm_login, '__none__'))
         ORDER BY day_index ASC, group_key ASC`
      )
      .bind(filters.startAt, filters.endAt, ...sources);
  }

  decodeTimeseries(result: SqlResult): AnalyticsTimeseriesResponse {
    const series: AnalyticsTimeseriesResponse["series"] = [];
    for (const row of parseRows(result.results, timeseriesRowSchema, "analytics timeseries row")) {
      const date = utcDateFromDayIndex(row.day_index);
      const lastPoint = series[series.length - 1];
      if (lastPoint?.date === date) {
        lastPoint.groups[row.group_key] = (lastPoint.groups[row.group_key] ?? 0) + row.count;
        continue;
      }

      series.push({
        date,
        groups: { [row.group_key]: row.count },
      });
    }

    return { series };
  }

  async getBreakdown(
    filters: AnalyticsFilters,
    by: AnalyticsBreakdownBy
  ): Promise<AnalyticsBreakdownResponse> {
    const result = await this.prepareBreakdown(filters, by).all<BreakdownRow>();
    return this.decodeBreakdown(result);
  }

  /**
   * How a breakdown buckets sessions. Shared with `prepareModelUsage` so the
   * cost of a bucket is summed over exactly the sessions the bucket counts.
   */
  private groupExpression(by: AnalyticsBreakdownBy): string {
    if (by === "user") return "COALESCE(s.user_id, NULLIF(s.scm_login, ''), '__unknown__')";
    if (by === "session") return "s.id";
    return REPO_GROUP_EXPRESSION;
  }

  /**
   * Token usage per bucket per model, over the same window and spawn-source
   * filter as `prepareBreakdown`. Pricing happens in `decodeModelUsage` rather
   * than in SQL, so a corrected rate reprices history on the next read.
   */
  prepareModelUsage(filters: AnalyticsFilters, by: AnalyticsBreakdownBy): SqlStatement {
    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT
           ${this.groupExpression(by)} AS key,
           m.model_id AS model_id,
           COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(m.cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(m.reasoning_tokens), 0) AS reasoning_tokens
         FROM session_model_usage m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.created_at >= ? AND s.created_at < ?
           AND s.spawn_source IN (${placeholders})
         GROUP BY key, m.model_id`
      )
      .bind(filters.startAt, filters.endAt, ...sources);
  }

  /** Priced usage per bucket key, for merging into a breakdown. */
  decodeModelUsage(result: SqlResult): Map<string, UsageCostRollup> {
    const byKey = new Map<string, Array<[string, ModelTokenUsage]>>();
    for (const row of parseRows(result.results, modelUsageRowSchema, "analytics model usage row")) {
      const key = row.key ?? NO_REPOSITORY_ANALYTICS_KEY;
      const entries = byKey.get(key) ?? [];
      entries.push([
        row.model_id,
        {
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheWrite: row.cache_write_tokens,
          reasoning: row.reasoning_tokens,
        },
      ]);
      byKey.set(key, entries);
    }
    return new Map([...byKey].map(([key, entries]) => [key, rollupUsageCost(entries)]));
  }

  prepareBreakdown(filters: AnalyticsFilters, by: AnalyticsBreakdownBy): SqlStatement {
    const isUserBreakdown = by === "user";
    const isSessionBreakdown = by === "session";
    const repoGroupExpression = REPO_GROUP_EXPRESSION;

    const groupExpression = this.groupExpression(by);

    const displayNameSelect = isUserBreakdown
      ? "COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), 'Unknown user') AS display_name,"
      : isSessionBreakdown
        ? `MAX(COALESCE(NULLIF(s.title, ''), s.id)) AS display_name,
           MAX(${repoGroupExpression}) AS repository,
           COALESCE(MAX(NULLIF(u.display_name, '')), MAX(NULLIF(s.scm_login, '')), 'Unknown user') AS user_name,
           MAX(s.status) AS status,`
        : "NULL AS display_name,";

    const joinClause =
      isUserBreakdown || isSessionBreakdown ? "LEFT JOIN users u ON s.user_id = u.id" : "";

    const orderTail = isSessionBreakdown
      ? "last_active DESC, key ASC"
      : isUserBreakdown
        ? "display_name ASC"
        : "key ASC";

    const sources = filters.spawnSources ?? HUMAN_SPAWN_SOURCES;
    const placeholders = sources.map(() => "?").join(", ");

    return this.db
      .prepare(
        `SELECT
           ${groupExpression} AS key,
           ${displayNameSelect}
           COUNT(*) AS sessions,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
           COALESCE(SUM(total_cost), 0) AS cost,
           SUM(total_tokens) AS total_tokens,
           COALESCE(SUM(pr_count), 0) AS prs,
           COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(
             AVG(CASE WHEN ${isSessionBreakdown ? "1 = 1" : "status IN ('completed', 'failed', 'cancelled')"} THEN active_duration_ms END),
             0
           ) AS avg_duration,
           MAX(s.updated_at) AS last_active
         FROM sessions s
         ${joinClause}
         WHERE s.created_at >= ? AND s.created_at < ?
           AND s.spawn_source IN (${placeholders})
         GROUP BY key
         ORDER BY sessions DESC, ${orderTail}`
      )
      .bind(filters.startAt, filters.endAt, ...sources);
  }

  /** Attach each bucket's priced usage to its breakdown entry. */
  mergeModelUsage(
    breakdown: AnalyticsBreakdownResponse,
    usage: Map<string, UsageCostRollup>
  ): AnalyticsBreakdownResponse {
    return {
      entries: breakdown.entries.map((entry) => {
        const rollup = usage.get(entry.key);
        return rollup ? { ...entry, computedCost: toComputedCost(rollup) } : entry;
      }),
    };
  }

  /**
   * One computed cost covering every bucket, for the dashboard summary. Models
   * are re-aggregated across buckets so each appears once in the total.
   */
  totalComputedCost(byKey: Map<string, UsageCostRollup>): AnalyticsComputedCost {
    const combined = new Map<string, ModelTokenUsage>();
    for (const rollup of byKey.values()) {
      for (const model of rollup.models) {
        const current = combined.get(model.modelId);
        if (!current) {
          combined.set(model.modelId, { ...model.usage });
          continue;
        }
        current.input += model.usage.input;
        current.output += model.usage.output;
        current.cacheRead += model.usage.cacheRead;
        current.cacheWrite += model.usage.cacheWrite;
        current.reasoning += model.usage.reasoning;
      }
    }
    return toComputedCost(rollupUsageCost(combined));
  }

  decodeBreakdown(result: SqlResult): AnalyticsBreakdownResponse {
    const entries: AnalyticsBreakdownEntry[] = parseRows(
      result.results,
      breakdownRowSchema,
      "analytics breakdown row"
    ).map((row) => ({
      key: row.key ?? NO_REPOSITORY_ANALYTICS_KEY,
      ...(row.display_name != null && { displayName: row.display_name }),
      totalTokens: row.total_tokens ?? null,
      ...(row.repository !== undefined && { repository: row.repository }),
      ...(row.user_name !== undefined && { user: row.user_name }),
      ...(row.status !== undefined && { status: row.status }),
      sessions: row.sessions,
      completed: row.completed,
      failed: row.failed,
      cancelled: row.cancelled,
      cost: row.cost,
      prs: row.prs,
      messageCount: row.message_count,
      avgDuration: row.avg_duration,
      lastActive: row.last_active,
    }));

    return { entries };
  }
}

function parseOptionalRow<Schema extends z.ZodType>(
  row: unknown,
  schema: Schema,
  name: string
): z.infer<Schema> | undefined {
  if (row === undefined) return undefined;
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new Error(`Invalid ${name}`);
  return parsed.data;
}

function parseRows<Schema extends z.ZodType>(
  rows: unknown[] | undefined,
  schema: Schema,
  name: string
): Array<z.infer<Schema>> {
  return (rows ?? []).map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error(`Invalid ${name}`);
    return parsed.data;
  });
}

export function toComputedCost(rollup: UsageCostRollup): AnalyticsComputedCost {
  return {
    costUsd: rollup.costUsd,
    hasUnpricedModels: rollup.hasUnpricedModels,
    models: rollup.models.map((model) => ({
      modelId: model.modelId,
      totalTokens: model.totalTokens,
      inputTokens: model.usage.input,
      outputTokens: model.usage.output,
      cacheReadTokens: model.usage.cacheRead,
      cacheWriteTokens: model.usage.cacheWrite,
      costUsd: model.costUsd,
    })),
  };
}
