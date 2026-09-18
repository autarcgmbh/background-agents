import type {
  AnalyticsDashboardResponse,
  AnalyticsDays,
} from "@open-inspect/shared/types/analytics";
import { AnalyticsStore, HUMAN_SPAWN_SOURCES } from "./analytics-store";
import { PullRequestAnalyticsStore } from "./pull-request-analytics-store";
import type { SqlDatabase } from "./sql-database";

export interface AnalyticsDashboardFilters {
  days: AnalyticsDays;
  startAt: number;
  endAt: number;
}

export class AnalyticsDashboardStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(filters: AnalyticsDashboardFilters): Promise<AnalyticsDashboardResponse> {
    const analytics = new AnalyticsStore(this.db);
    const pullRequests = new PullRequestAnalyticsStore(this.db);
    const sessionFilters = {
      startAt: filters.startAt,
      endAt: filters.endAt,
      spawnSources: HUMAN_SPAWN_SOURCES,
    };
    const pullRequestStatements = pullRequests.prepare({
      startAt: filters.startAt,
      endAt: filters.endAt,
      now: filters.endAt,
    });

    const [
      summary,
      timeseries,
      repository,
      user,
      session,
      repositoryUsage,
      userUsage,
      sessionUsage,
      ...pullRequestResults
    ] = await this.db.batch([
      analytics.prepareSummary(sessionFilters),
      analytics.prepareTimeseries(sessionFilters),
      analytics.prepareBreakdown(sessionFilters, "repo"),
      analytics.prepareBreakdown(sessionFilters, "user"),
      analytics.prepareBreakdown(sessionFilters, "session"),
      analytics.prepareModelUsage(sessionFilters, "repo"),
      analytics.prepareModelUsage(sessionFilters, "user"),
      analytics.prepareModelUsage(sessionFilters, "session"),
      ...pullRequestStatements,
    ]);

    // The window's total is summed from the per-session split rather than the
    // per-user or per-repo one: a session has exactly one of each, so all three
    // agree, and the session split is the finest grain available.
    const sessionCost = analytics.decodeModelUsage(sessionUsage);
    const windowCost = analytics.totalComputedCost(sessionCost);

    return {
      generatedAt: filters.endAt,
      window: {
        days: filters.days,
        startAt: filters.startAt,
        endAt: filters.endAt,
      },
      summary: { ...analytics.decodeSummary(summary), computedCost: windowCost },
      timeseries: analytics.decodeTimeseries(timeseries),
      breakdowns: {
        repository: analytics.mergeModelUsage(
          analytics.decodeBreakdown(repository),
          analytics.decodeModelUsage(repositoryUsage)
        ),
        user: analytics.mergeModelUsage(
          analytics.decodeBreakdown(user),
          analytics.decodeModelUsage(userUsage)
        ),
        session: analytics.mergeModelUsage(analytics.decodeBreakdown(session), sessionCost),
      },
      pullRequests: pullRequests.decode(pullRequestResults),
    };
  }
}
