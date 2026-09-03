import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotStopped,
  clearStopMarker,
  markStopConfirmed,
  markStopRequested,
  readStopMarker,
  STOP_MARKER_TTL_SECONDS,
  StopRequestedError,
} from "./stop-marker";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("stop markers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("markStopRequested writes a requested marker under stop:<agentSessionId> with a TTL", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeLinearBotEnv(kv);

    await markStopRequested(env, "agent-session-1", {
      actorUserId: "human-1",
      source: "agent_activity",
    });

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].key).toBe("stop:agent-session-1");
    expect(putCalls[0].options).toEqual({ expirationTtl: STOP_MARKER_TTL_SECONDS });
    expect(JSON.parse(putCalls[0].value)).toEqual({
      state: "requested",
      requestedAt: Date.now(),
      actorUserId: "human-1",
      source: "agent_activity",
    });
  });

  it("STOP_MARKER_TTL_SECONDS outlives a single agent-session flow", () => {
    expect(STOP_MARKER_TTL_SECONDS).toBe(600);
  });

  it("readStopMarker returns null when no marker exists", async () => {
    const { kv } = createFakeKV();

    await expect(readStopMarker(makeLinearBotEnv(kv), "agent-session-1")).resolves.toBeNull();
  });

  it("readStopMarker round-trips a written marker", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await markStopRequested(env, "agent-session-1", { source: "unassigned" });

    await expect(readStopMarker(env, "agent-session-1")).resolves.toEqual({
      state: "requested",
      requestedAt: Date.now(),
      source: "unassigned",
    });
  });

  it("readStopMarker treats invalid JSON as a requested marker", async () => {
    const { kv } = createFakeKV({ "stop:agent-session-1": "{not-json" });

    await expect(readStopMarker(makeLinearBotEnv(kv), "agent-session-1")).resolves.toEqual({
      state: "requested",
      requestedAt: 0,
      source: "agent_activity",
    });
  });

  it("readStopMarker treats a marker with an unknown shape as requested", async () => {
    const { kv } = createFakeKV({
      "stop:agent-session-1": JSON.stringify({ state: "done", requestedAt: "yesterday" }),
    });

    await expect(readStopMarker(makeLinearBotEnv(kv), "agent-session-1")).resolves.toMatchObject({
      state: "requested",
    });
  });

  it("markStopConfirmed keeps the request metadata and flips the state", async () => {
    const { kv, store } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await markStopRequested(env, "agent-session-1", {
      actorUserId: "human-1",
      source: "unassigned",
    });
    const requestedAt = Date.now();
    vi.advanceTimersByTime(5_000);

    await markStopConfirmed(env, "agent-session-1");

    expect(JSON.parse(store.get("stop:agent-session-1") ?? "null")).toEqual({
      state: "confirmed",
      requestedAt,
      actorUserId: "human-1",
      source: "unassigned",
    });
  });

  it("markStopConfirmed writes a fresh confirmed marker when none was requested", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeLinearBotEnv(kv);

    await markStopConfirmed(env, "agent-session-1");

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].options).toEqual({ expirationTtl: STOP_MARKER_TTL_SECONDS });
    expect(JSON.parse(putCalls[0].value)).toEqual({
      state: "confirmed",
      requestedAt: Date.now(),
      source: "agent_activity",
    });
  });

  it("clearStopMarker deletes the marker key", async () => {
    const { kv, store } = createFakeKV({ "stop:agent-session-1": "{}" });
    const env = makeLinearBotEnv(kv);

    await clearStopMarker(env, "agent-session-1");

    expect(kv.delete).toHaveBeenCalledWith("stop:agent-session-1");
    expect(store.has("stop:agent-session-1")).toBe(false);
  });

  it("assertNotStopped resolves when no marker exists", async () => {
    const { kv } = createFakeKV();

    await expect(
      assertNotStopped(makeLinearBotEnv(kv), "agent-session-1", "before_prompt")
    ).resolves.toBeUndefined();
  });

  it.each(["requested", "confirmed"])(
    "assertNotStopped throws a StopRequestedError carrying the checkpoint for a %s marker",
    async (state) => {
      const { kv } = createFakeKV({
        "stop:agent-session-1": JSON.stringify({
          state,
          requestedAt: Date.now(),
          source: "agent_activity",
        }),
      });

      const failure = await assertNotStopped(
        makeLinearBotEnv(kv),
        "agent-session-1",
        "before_prompt"
      ).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(StopRequestedError);
      const stop = failure as StopRequestedError;
      expect(stop.agentSessionId).toBe("agent-session-1");
      expect(stop.checkpoint).toBe("before_prompt");
      expect(stop.name).toBe("StopRequestedError");
      expect(stop.message).toContain("agent-session-1");
      expect(stop.message).toContain("before_prompt");
    }
  );

  it("assertNotStopped fails closed on a malformed marker", async () => {
    const { kv } = createFakeKV({ "stop:agent-session-1": "garbage" });

    await expect(
      assertNotStopped(makeLinearBotEnv(kv), "agent-session-1", "after_ack")
    ).rejects.toBeInstanceOf(StopRequestedError);
  });
});
