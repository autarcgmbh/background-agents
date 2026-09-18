import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";

describe("session token usage", () => {
  let db: DatabaseSync;
  let repository: EventRepository;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    storage.sql.exec(
      `CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT, data TEXT, message_id TEXT, created_at INTEGER, timeline_sequence INTEGER)`
    );
    repository = new EventRepository(storage.sql, storage.transactionSync);
  });
  afterEach(() => db.close());
  const step = (
    overrides: Partial<Extract<SandboxEvent, { type: "step_finish" }>> = {}
  ): Extract<SandboxEvent, { type: "step_finish" }> => ({
    type: "step_finish",
    sandboxId: "sandbox",
    messageId: "message",
    timestamp: 1,
    stepId: "step",
    ...overrides,
  });

  it("records usage without cost and replaces repeated reports of the same step", () => {
    expect(repository.getTotalTokens()).toBeNull();
    repository.recordStepUsage(
      step({ tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 50, write: 5 } } }),
      1
    );
    // 100 input + 20 output + 50 cache read + 5 cache write. The 10 reasoning
    // tokens are not added: providers that report them separately also count
    // them inside output, so adding both would double-count thinking.
    expect(repository.getTotalTokens()).toBe(175);
    repository.recordStepUsage(step({ tokens: 200 }), 2);
    repository.recordStepUsage(step({ tokens: 200 }), 3);
    expect(repository.getTotalTokens()).toBe(200);
    repository.recordStepUsage(
      step({ stepId: "next", tokens: { total: 30, input: 20, output: 10 } }),
      4
    );
    repository.recordStepUsage(step({ messageId: "second-turn", tokens: 40 }), 5);
    repository.recordStepUsage(step({ childSessionId: "child", tokens: 50 }), 6);
    expect(repository.getTotalTokens()).toBe(320);
  });

  describe("per-model attribution", () => {
    it("splits usage by the model each step names", () => {
      repository.recordStepUsage(
        step({ stepId: "a", model: "anthropic/claude-opus-5", tokens: { input: 100, output: 20 } }),
        1
      );
      repository.recordStepUsage(
        step({ stepId: "b", model: "anthropic/claude-haiku-4-5", tokens: { input: 5, output: 1 } }),
        2
      );
      repository.recordStepUsage(
        step({ stepId: "c", model: "anthropic/claude-opus-5", tokens: { output: 30 } }),
        3
      );
      expect(repository.getUsageByModel()).toEqual([
        {
          modelId: "anthropic/claude-opus-5",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        },
        {
          modelId: "anthropic/claude-haiku-4-5",
          usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        },
      ]);
    });

    it("pools usage from runtimes that name no model, so it counts but never prices", () => {
      repository.recordStepUsage(step({ stepId: "a", tokens: { input: 10, output: 2 } }), 1);
      expect(repository.getUsageByModel()).toEqual([
        {
          modelId: "unattributed",
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        },
      ]);
    });

    it("keeps a bare total out of the priced components", () => {
      repository.recordStepUsage(step({ stepId: "a", tokens: 200 }), 1);
      const [entry] = repository.getUsageByModel() ?? [];
      // Carried as input only so the token count stays right; the step named
      // no model, so it is unattributed and excluded from cost either way.
      expect(entry).toEqual({
        modelId: "unattributed",
        usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      });
    });

    it("reports null when nothing was reported, which is not an empty split", () => {
      expect(repository.getUsageByModel()).toBeNull();
    });
  });

  it("distinguishes missing, invalid, and zero usage and ignores reports without step identity", () => {
    repository.recordStepUsage(step(), 1);
    repository.recordStepUsage(step({ tokens: -1 }), 2);
    expect(repository.getTotalTokens()).toBeNull();
    repository.recordStepUsage(step({ tokens: 0 }), 3);
    expect(repository.getTotalTokens()).toBe(0);
    repository.recordStepUsage(step({ stepId: undefined, tokens: 10 }), 4);
    repository.recordStepUsage(step({ stepId: undefined, tokens: 20 }), 5);
    expect(repository.getTotalTokens()).toBe(0);
  });
});
