import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type { LinearProgressCallback } from "@open-inspect/shared/types/session-api";
import { callbacksRouter } from "./callbacks";
import {
  createProgressCallbackRouter,
  formatHeartbeatThought,
} from "./callbacks/progress-callback";
import { KEEPALIVE_INTERVAL_SECONDS } from "./kv-store";
import { createFakeKV, makeExecutionContext, makeLinearBotEnv } from "./test-helpers";
import type { LinearApiClient } from "./utils/linear-client";

const NOW = 1_700_000_000_000;
const SECRET = "callback-secret";

const client: LinearApiClient = {
  accessToken: "token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

const agentContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
  agentSessionId: "agent-session-1",
  organizationId: "org-1",
  appUserId: "app-user-1",
};

async function signedPayload(overrides: Record<string, unknown> = {}) {
  const data = {
    sessionId: "session-1",
    messageId: "message-1",
    timestamp: NOW,
    elapsedMs: 90_000,
    trigger: "heartbeat",
    toolCallCount: 3,
    context: agentContext,
    ...overrides,
  };
  return { ...data, signature: await computeHmacHex(JSON.stringify(data), SECRET) };
}

function makeRouter(overrides: Partial<Parameters<typeof createProgressCallbackRouter>[0]> = {}) {
  const getLinearClient = vi.fn(async () => client);
  const emitAgentActivity = vi.fn(async () => true);
  const router = createProgressCallbackRouter({
    getLinearClient: getLinearClient as never,
    emitAgentActivity: emitAgentActivity as never,
    now: () => NOW,
    ...overrides,
  });
  return { router, getLinearClient, emitAgentActivity };
}

async function postProgress(
  router: { fetch: typeof callbacksRouter.fetch },
  payload: unknown,
  kv = createFakeKV().kv
): Promise<Response> {
  return router.fetch(
    new Request("http://localhost/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
    makeExecutionContext()
  );
}

describe("POST /callbacks/progress", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is mounted on the callbacks router", async () => {
    const { kv } = createFakeKV();
    const response = await callbacksRouter.fetch(
      new Request("http://localhost/progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(await signedPayload()), signature: "invalid" }),
      }),
      makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
      makeExecutionContext()
    );

    expect(response.status).toBe(401);
  });

  it("rejects a callback with an invalid signature", async () => {
    const { router, emitAgentActivity } = makeRouter();

    const response = await postProgress(router, {
      ...(await signedPayload()),
      signature: "invalid",
    });

    expect(response.status).toBe(401);
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { router } = makeRouter();

    const response = await router.fetch(
      new Request("http://localhost/progress", { method: "POST", body: "{not-json" }),
      makeLinearBotEnv(createFakeKV().kv, { SERVICE_AUTH_SECRET: SECRET }),
      makeExecutionContext()
    );

    expect(response.status).toBe(400);
  });

  it("rejects a payload without a signature field before schema validation", async () => {
    const { router } = makeRouter();
    const { signature: _signature, ...unsigned } = await signedPayload();
    void _signature;

    const response = await postProgress(router, unsigned);

    expect(response.status).toBe(400);
  });

  it.each([
    ["elapsedMs", undefined],
    ["trigger", "tick"],
    ["latestText", "x".repeat(2001)],
  ])("rejects a payload whose %s is invalid", async (field, value) => {
    const { router, emitAgentActivity } = makeRouter();
    const response = await postProgress(router, await signedPayload({ [field]: value }));

    expect(response.status).toBe(400);
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("acknowledges a stale callback without emitting", async () => {
    const { router, emitAgentActivity } = makeRouter();

    const response = await postProgress(
      router,
      await signedPayload({ timestamp: NOW - 10 * 60 * 1000 })
    );

    expect(await response.json()).toEqual({ ok: true, outcome: "stale_callback" });
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("skips callbacks whose context carries no agent session", async () => {
    const { router, getLinearClient } = makeRouter();
    const { agentSessionId: _agentSessionId, ...context } = agentContext;
    void _agentSessionId;

    const response = await postProgress(router, await signedPayload({ context }));

    expect(await response.json()).toEqual({ ok: true, outcome: "missing_agent_context" });
    expect(getLinearClient).not.toHaveBeenCalled();
  });

  it("does not resurrect a message that already completed", async () => {
    const { router, emitAgentActivity } = makeRouter();
    const { kv } = createFakeKV({ "completed:session-1:message-1": "1" });

    const response = await postProgress(router, await signedPayload(), kv);

    expect(await response.json()).toEqual({ ok: true, outcome: "message_completed" });
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("throttles a heartbeat while the keepalive slot is held", async () => {
    const { router, emitAgentActivity } = makeRouter();
    const { kv } = createFakeKV({ "keepalive:agent-session-1": String(NOW) });

    const response = await postProgress(router, await signedPayload(), kv);

    expect(await response.json()).toEqual({ ok: true, outcome: "throttled" });
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("emits an ephemeral keepalive thought for a heartbeat and claims the slot", async () => {
    const { router, getLinearClient, emitAgentActivity } = makeRouter();
    const { kv, store, putCalls } = createFakeKV();

    const response = await postProgress(
      router,
      await signedPayload({ currentTool: { tool: "bash", callId: "call-1" } }),
      kv
    );

    expect(await response.json()).toEqual({ ok: true, outcome: "emitted" });
    expect(getLinearClient).toHaveBeenCalledWith(expect.anything(), "org-1", "app-user-1");
    expect(emitAgentActivity).toHaveBeenCalledOnce();
    expect(emitAgentActivity).toHaveBeenCalledWith(
      client,
      "agent-session-1",
      {
        type: "thought",
        body: "Still working — 3 tool calls so far, 2 min, currently running `bash`.",
      },
      { ephemeral: true }
    );
    expect(store.has("keepalive:agent-session-1")).toBe(true);
    expect(
      putCalls.filter((call) => call.key === "keepalive:agent-session-1").map((c) => c.options)
    ).toEqual(expect.arrayContaining([{ expirationTtl: KEEPALIVE_INTERVAL_SECONDS }]));
  });

  it("ignores a step_finish without text", async () => {
    const { router, emitAgentActivity } = makeRouter();

    for (const latestText of [undefined, "   "]) {
      const response = await postProgress(
        router,
        await signedPayload({ trigger: "step_finish", latestText })
      );
      expect(await response.json()).toEqual({ ok: true, outcome: "no_text" });
    }
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("emits a persistent thought for a step_finish and dedupes a repeated segment", async () => {
    const { router, emitAgentActivity } = makeRouter();
    const { kv, store } = createFakeKV();
    const payload = await signedPayload({
      trigger: "step_finish",
      latestText: "Found the bug in the auth middleware.",
      latestTextComplete: true,
    });

    const first = await postProgress(router, payload, kv);
    const second = await postProgress(router, payload, kv);

    expect(await first.json()).toEqual({ ok: true, outcome: "emitted" });
    expect(await second.json()).toEqual({ ok: true, outcome: "deduped" });
    expect(emitAgentActivity).toHaveBeenCalledOnce();
    expect(emitAgentActivity).toHaveBeenCalledWith(client, "agent-session-1", {
      type: "thought",
      body: "Found the bug in the auth middleware.",
    });
    expect(store.has("progress:text:agent-session-1")).toBe(true);
    expect(store.has("keepalive:agent-session-1")).toBe(true);
  });

  it("surfaces a step_finish even while a heartbeat holds the keepalive slot", async () => {
    const { router, emitAgentActivity } = makeRouter();
    const { kv } = createFakeKV({ "keepalive:agent-session-1": String(NOW) });

    const response = await postProgress(
      router,
      await signedPayload({ trigger: "step_finish", latestText: "Running the tests now." }),
      kv
    );

    expect(await response.json()).toEqual({ ok: true, outcome: "emitted" });
    expect(emitAgentActivity).toHaveBeenCalledOnce();
  });

  it("reports a missing OAuth token", async () => {
    const { router, emitAgentActivity } = makeRouter({ getLinearClient: vi.fn(async () => null) });

    const response = await postProgress(router, await signedPayload());

    expect(await response.json()).toEqual({ ok: true, outcome: "no_oauth_token" });
    expect(emitAgentActivity).not.toHaveBeenCalled();
  });

  it("reports a failed emission and leaves the keepalive untouched afterwards", async () => {
    const { router } = makeRouter({ emitAgentActivity: vi.fn(async () => false) });
    const { kv, putCalls } = createFakeKV();

    const response = await postProgress(
      router,
      await signedPayload({ trigger: "step_finish", latestText: "Half way there." }),
      kv
    );

    expect(await response.json()).toEqual({ ok: true, outcome: "emit_failed" });
    expect(putCalls.map((call) => call.key)).toEqual(["progress:text:agent-session-1"]);
  });
});

describe("formatHeartbeatThought", () => {
  function payload(overrides: Partial<LinearProgressCallback> = {}): LinearProgressCallback {
    return {
      sessionId: "session-1",
      messageId: "message-1",
      timestamp: NOW,
      elapsedMs: 20_000,
      trigger: "heartbeat",
      signature: "sig",
      context: agentContext as LinearProgressCallback["context"],
      ...overrides,
    };
  }

  it("describes a young run without tool calls", () => {
    expect(formatHeartbeatThought(payload())).toBe("Still working — under a minute.");
  });

  it("pluralizes tool calls and rounds elapsed minutes", () => {
    expect(formatHeartbeatThought(payload({ toolCallCount: 1, elapsedMs: 89_000 }))).toBe(
      "Still working — 1 tool call so far, 1 min."
    );
    expect(formatHeartbeatThought(payload({ toolCallCount: 12, elapsedMs: 10 * 60_000 }))).toBe(
      "Still working — 12 tool calls so far, 10 min."
    );
  });

  it("reports zero tool calls explicitly", () => {
    expect(formatHeartbeatThought(payload({ toolCallCount: 0 }))).toBe(
      "Still working — 0 tool calls so far, under a minute."
    );
  });

  it("names the running tool", () => {
    expect(
      formatHeartbeatThought(payload({ currentTool: { tool: "edit_file", callId: "call-1" } }))
    ).toBe("Still working — under a minute, currently running `edit_file`.");
  });

  it("puts the latest text first and the status in italics", () => {
    expect(formatHeartbeatThought(payload({ latestText: "Reading the schema." }))).toBe(
      "Reading the schema.\n\n_Still working — under a minute._"
    );
  });
});
