// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as matchers from "@testing-library/jest-dom/matchers";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsSessionTable } from "./session-table";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";

expect.extend(matchers);
afterEach(cleanup);

const entry = (key: string, totalTokens: number | null): AnalyticsBreakdownEntry => ({
  key,
  displayName: key,
  user: "Alice",
  repository: "group/repo",
  status: "completed",
  sessions: 1,
  completed: 1,
  failed: 0,
  cancelled: 0,
  cost: 0,
  totalTokens,
  prs: 0,
  messageCount: 2,
  avgDuration: 5000,
  lastActive: Date.now(),
});

describe("AnalyticsSessionTable", () => {
  it("shows tokens for zero-cost threads, distinguishes missing usage, and links to the thread", () => {
    render(
      <AnalyticsSessionTable
        entries={[entry("known", 12000), entry("unknown", null)]}
        loading={false}
      />
    );
    expect(screen.getByText("12,000")).toBeInTheDocument();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "known" })).toHaveAttribute("href", "/session/known");
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(within(screen.getAllByRole("row")[1]).getByRole("link")).toHaveTextContent("known");
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "unknown" },
    });
    expect(screen.queryByRole("link", { name: "known" })).not.toBeInTheDocument();
  });

  it("values a seat-billed thread's tokens and breaks the cost down by model", () => {
    const priced: AnalyticsBreakdownEntry = {
      ...entry("seat", 1_100_000),
      computedCost: {
        costUsd: 7.5,
        hasUnpricedModels: false,
        models: [
          {
            modelId: "anthropic/claude-opus-5",
            totalTokens: 1_100_000,
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 7.5,
          },
        ],
      },
    };
    render(<AnalyticsSessionTable entries={[priced]} loading={false} />);

    // The provider reported nothing for a seat; the token cost is the real signal.
    const costButton = screen.getByRole("button", { name: "$7.50" });
    expect(screen.getByText("$0.0")).toBeInTheDocument();

    expect(screen.queryByText("Claude Opus 5")).not.toBeInTheDocument();
    fireEvent.click(costButton);
    expect(screen.getByText("Claude Opus 5")).toBeInTheDocument();
    expect(screen.getByText("1,000,000")).toBeInTheDocument();
    expect(screen.getByText("100,000")).toBeInTheDocument();

    fireEvent.click(costButton);
    expect(screen.queryByText("Claude Opus 5")).not.toBeInTheDocument();
  });

  it("marks a total that excludes an unpriced model rather than understating it silently", () => {
    const mixed: AnalyticsBreakdownEntry = {
      ...entry("mixed", 2_000_000),
      computedCost: {
        costUsd: 1,
        hasUnpricedModels: true,
        models: [
          {
            modelId: "anthropic/claude-haiku-4-5",
            totalTokens: 1_000_000,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 1,
          },
          {
            modelId: "opencode/glm-5",
            totalTokens: 1_000_000,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: null,
          },
        ],
      },
    };
    render(<AnalyticsSessionTable entries={[mixed]} loading={false} />);

    fireEvent.click(screen.getByRole("button", { name: "$1.00+" }));
    expect(screen.getByText("No list price")).toBeInTheDocument();
    expect(screen.getByText(/lower bound/)).toBeInTheDocument();
  });

  it("sorts unpriced threads last, since unknown cost is not the cheapest", () => {
    const withCost = (key: string, costUsd: number | null): AnalyticsBreakdownEntry => ({
      ...entry(key, 1000),
      ...(costUsd === null
        ? {}
        : { computedCost: { costUsd, hasUnpricedModels: false, models: [] } }),
    });
    render(
      <AnalyticsSessionTable
        entries={[withCost("cheap", 1), withCost("none", null), withCost("dear", 9)]}
        loading={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Token cost" }));
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).queryByRole("link")?.textContent);
    expect(names).toEqual(["dear", "cheap", "none"]);
  });

  it("pages through every session", () => {
    render(
      <AnalyticsSessionTable
        entries={Array.from({ length: 26 }, (_, index) => entry(`session-${index}`, index))}
        loading={false}
      />
    );
    expect(screen.getAllByRole("link")).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("shows loading and empty states", () => {
    const { rerender } = render(<AnalyticsSessionTable loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading session usage");
    rerender(<AnalyticsSessionTable entries={[]} loading={false} />);
    expect(screen.getByText("No sessions found for this range.")).toBeInTheDocument();
  });
});
