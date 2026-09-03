import { describe, expect, it } from "vitest";
import {
  HISTORY_MAX_CHARS,
  HISTORY_MAX_TURNS,
  HISTORY_TURN_MAX_CHARS,
  historyHasAgentTurn,
  selectConversationHistory,
} from "./conversation-history";
import type { AgentSessionActivity, AgentSessionActivityKind } from "./utils/linear-client";

let counter = 0;

function activity(
  kind: AgentSessionActivityKind,
  body: string,
  overrides: Partial<AgentSessionActivity> = {}
): AgentSessionActivity {
  counter += 1;
  return {
    id: `activity-${counter}`,
    createdAt: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    ephemeral: false,
    signal: null,
    kind,
    body,
    ...overrides,
  };
}

describe("selectConversationHistory", () => {
  it("keeps prompts, responses, errors and elicitations oldest first", () => {
    const history = selectConversationHistory([
      activity("prompt", "Fix the login bug"),
      activity("elicitation", "Which repository?"),
      activity("prompt", "acme/backend"),
      activity("response", "Opened a PR"),
      activity("error", "CI failed"),
    ]);

    expect(history).toEqual([
      { kind: "prompt", body: "Fix the login bug" },
      { kind: "elicitation", body: "Which repository?" },
      { kind: "prompt", body: "acme/backend" },
      { kind: "response", body: "Opened a PR" },
      { kind: "error", body: "CI failed" },
    ]);
  });

  it("drops thoughts, actions and ephemeral rows", () => {
    const history = selectConversationHistory([
      activity("thought", "Analyzing issue..."),
      activity("action", "Run npm test"),
      activity("prompt", "Please continue", { ephemeral: true }),
      activity("response", "Still here", { ephemeral: true }),
      activity("response", "Done"),
    ]);

    expect(history).toEqual([{ kind: "response", body: "Done" }]);
  });

  it("drops stop-signal prompts and blank bodies", () => {
    const history = selectConversationHistory([
      activity("prompt", "Start the work"),
      activity("prompt", "stop", { signal: "stop" }),
      activity("prompt", "   "),
      activity("response", ""),
    ]);

    expect(history).toEqual([{ kind: "prompt", body: "Start the work" }]);
  });

  it("trims turn bodies before comparing them", () => {
    const history = selectConversationHistory([activity("prompt", "  spaced out  ")]);

    expect(history).toEqual([{ kind: "prompt", body: "spaced out" }]);
  });

  it("excludes only the latest prompt matching excludeLatestPromptBody", () => {
    const history = selectConversationHistory(
      [
        activity("prompt", "Please continue."),
        activity("response", "Continued once"),
        activity("prompt", "Please continue."),
      ],
      { excludeLatestPromptBody: "Please continue." }
    );

    expect(history).toEqual([
      { kind: "prompt", body: "Please continue." },
      { kind: "response", body: "Continued once" },
    ]);
  });

  it("matches the excluded prompt after trimming both sides", () => {
    const history = selectConversationHistory([activity("prompt", "acme/backend ")], {
      excludeLatestPromptBody: "  acme/backend",
    });

    expect(history).toEqual([]);
  });

  it("does not exclude a response that happens to share the prompt text", () => {
    const history = selectConversationHistory([activity("response", "ok")], {
      excludeLatestPromptBody: "ok",
    });

    expect(history).toEqual([{ kind: "response", body: "ok" }]);
  });

  it("ignores an empty excludeLatestPromptBody", () => {
    const history = selectConversationHistory([activity("prompt", "keep me")], {
      excludeLatestPromptBody: "   ",
    });

    expect(history).toEqual([{ kind: "prompt", body: "keep me" }]);
  });

  it("truncates a single turn to the per-turn cap with an ellipsis", () => {
    const long = "x".repeat(HISTORY_TURN_MAX_CHARS + 50);

    const [turn] = selectConversationHistory([activity("response", long)]);

    expect(turn.body).toHaveLength(HISTORY_TURN_MAX_CHARS);
    expect(turn.body.endsWith("…")).toBe(true);
    expect(turn.body.startsWith("x".repeat(HISTORY_TURN_MAX_CHARS - 1))).toBe(true);
  });

  it("leaves a turn exactly at the per-turn cap untouched", () => {
    const exact = "y".repeat(HISTORY_TURN_MAX_CHARS);

    const [turn] = selectConversationHistory([activity("response", exact)]);

    expect(turn.body).toBe(exact);
  });

  it("keeps at most the newest HISTORY_MAX_TURNS turns", () => {
    const activities = Array.from({ length: HISTORY_MAX_TURNS + 3 }, (_, i) =>
      activity("prompt", `turn ${i}`)
    );

    const history = selectConversationHistory(activities);

    expect(history).toHaveLength(HISTORY_MAX_TURNS);
    expect(history[0].body).toBe("turn 3");
    expect(history.at(-1)?.body).toBe(`turn ${HISTORY_MAX_TURNS + 2}`);
  });

  it("drops the oldest turns once the total character budget is exhausted", () => {
    // Six 800-char turns is 4800 chars; only the newest five fit in 4000.
    const activities = Array.from({ length: 6 }, (_, i) =>
      activity("response", String(i).repeat(HISTORY_TURN_MAX_CHARS))
    );

    const history = selectConversationHistory(activities);

    expect(history.map((turn) => turn.body[0])).toEqual(["1", "2", "3", "4", "5"]);
    expect(history.reduce((sum, turn) => sum + turn.body.length, 0)).toBeLessThanOrEqual(
      HISTORY_MAX_CHARS
    );
  });

  it("always keeps the newest turn even when it alone exceeds the total budget", () => {
    const [turn] = selectConversationHistory([
      activity("response", "z".repeat(HISTORY_MAX_CHARS + 500)),
    ]);

    expect(turn.body).toHaveLength(HISTORY_TURN_MAX_CHARS);
  });

  it("returns an empty list for no activities", () => {
    expect(selectConversationHistory([])).toEqual([]);
  });
});

describe("historyHasAgentTurn", () => {
  it("is true when a response is present", () => {
    expect(
      historyHasAgentTurn([
        { kind: "prompt", body: "hi" },
        { kind: "response", body: "hello" },
      ])
    ).toBe(true);
  });

  it("is true when an error is present", () => {
    expect(historyHasAgentTurn([{ kind: "error", body: "boom" }])).toBe(true);
  });

  it("is false for prompts and elicitations only", () => {
    expect(
      historyHasAgentTurn([
        { kind: "prompt", body: "hi" },
        { kind: "elicitation", body: "which repo?" },
      ])
    ).toBe(false);
  });

  it("is false for an empty history", () => {
    expect(historyHasAgentTurn([])).toBe(false);
  });
});
