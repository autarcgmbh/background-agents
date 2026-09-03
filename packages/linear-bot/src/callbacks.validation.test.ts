import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbacksRouter } from "./callbacks";
import { cancelPlanFrom } from "./plan";
import {
  createFakeKV,
  createLinearFetchMock,
  linearClientCredentialsResponse,
  linearIdentityResponse,
  makeExecutionContext,
  makeLinearBotEnv,
  storedClientCredentialsToken,
} from "./test-helpers";

const SECRET = "callback-secret";

const validToolCall = {
  sessionId: "session-1",
  tool: "bash",
  args: { command: "npm test" },
  callId: "call-1",
  status: "running",
  timestamp: 1_700_000_000_000,
  context: {
    source: "linear",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueUrl: "https://linear.app/acme/issue/ENG-1",
    model: "anthropic/claude-haiku-4-5",
  },
};

const validCompletion = {
  sessionId: "session-1",
  messageId: "message-1",
  success: true,
  timestamp: 1_700_000_000_000,
  context: validToolCall.context,
};

async function sign(payload: Record<string, unknown>) {
  return { ...payload, signature: await computeHmacHex(JSON.stringify(payload), SECRET) };
}

async function postToolCall(payload: unknown): Promise<Response> {
  const { kv } = createFakeKV();
  return callbacksRouter.fetch(
    new Request("http://localhost/tool_call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
    makeExecutionContext()
  );
}

async function postCompletion(payload: unknown): Promise<Response> {
  const { kv } = createFakeKV();
  return callbacksRouter.fetch(
    new Request("http://localhost/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
    makeExecutionContext()
  );
}

describe("POST /tool_call callback validation", () => {
  it("accepts a valid signed callback", async () => {
    const response = await postToolCall(await sign(validToolCall));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each(["args", "callId"])("rejects a callback missing %s", async (field) => {
    const payload = { ...validToolCall } as Record<string, unknown>;
    delete payload[field];

    const response = await postToolCall(await sign(payload));

    expect(response.status).toBe(400);
  });

  it("rejects malformed Linear context", async () => {
    const response = await postToolCall(
      await sign({ ...validToolCall, context: { source: "linear", issueId: "issue-1" } })
    );

    expect(response.status).toBe(400);
  });

  it("rejects an invalid signature", async () => {
    const response = await postToolCall({ ...validToolCall, signature: "invalid" });

    expect(response.status).toBe(401);
  });
});

describe("POST /complete callback validation", () => {
  it("accepts a valid signed callback", async () => {
    const response = await postCompletion(await sign(validCompletion));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects malformed Linear context", async () => {
    const response = await postCompletion(
      await sign({ ...validCompletion, context: { source: "linear", issueId: "issue-1" } })
    );

    expect(response.status).toBe(400);
  });
});

// ─── Background processing of accepted callbacks ─────────────────────────────

describe("accepted callback processing", () => {
  const agentContext = {
    ...validToolCall.context,
    agentSessionId: "agent-session-1",
    organizationId: "org-1",
    appUserId: "app-user-1",
  };

  function linearCalls(): Array<{ operationName: string; input: Record<string, unknown> }> {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input) === "https://api.linear.app/graphql")
      .map(([, init]) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { input: Record<string, unknown> };
        };
        return {
          operationName: /\b(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "",
          input: body.variables.input,
        };
      });
  }

  async function postAndSettle(path: string, payload: unknown) {
    const { kv, store } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
    });
    const ctx = makeExecutionContext();
    const response = await callbacksRouter.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      makeLinearBotEnv(kv, { SERVICE_AUTH_SECRET: SECRET }),
      ctx
    );
    await Promise.all(ctx.waitUntil.mock.calls.map(([task]) => task as Promise<void>));
    return { response, store };
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () => linearClientCredentialsResponse(),
        identity: () => linearIdentityResponse(),
        graphql: () => Response.json({ data: {} }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("confirms a user-initiated stop with a canceled plan and no activity", async () => {
    const { response, store } = await postAndSettle(
      "/complete",
      await sign({
        ...validCompletion,
        success: false,
        terminationReason: "stopped",
        context: agentContext,
      })
    );

    expect(response.status).toBe(200);
    expect(store.has("completed:session-1:message-1")).toBe(true);
    const calls = linearCalls();
    expect(calls.map((call) => call.operationName)).toEqual(["AgentSessionUpdate"]);
    expect(calls[0].input).toEqual({ plan: cancelPlanFrom("session_created") });
  });

  it("treats the legacy stopped error text as a user-initiated stop", async () => {
    await postAndSettle(
      "/complete",
      await sign({
        ...validCompletion,
        success: false,
        error: "Execution was stopped",
        context: agentContext,
      })
    );

    expect(linearCalls().some((call) => call.operationName === "AgentActivityCreate")).toBe(false);
  });

  it("forwards a tool result inside the ephemeral action activity", async () => {
    const { store } = await postAndSettle(
      "/tool_call",
      await sign({
        ...validToolCall,
        status: "completed",
        result: "12 passed",
        context: agentContext,
      })
    );

    const activity = linearCalls().find((call) => call.operationName === "AgentActivityCreate");
    expect(activity?.input).toEqual({
      agentSessionId: "agent-session-1",
      content: {
        type: "action",
        action: "Run",
        parameter: "npm test",
        result: "```\n12 passed\n```",
      },
      ephemeral: true,
    });
    expect(store.has("keepalive:agent-session-1")).toBe(true);
  });

  it("emits an action without result while the tool is still running", async () => {
    await postAndSettle("/tool_call", await sign({ ...validToolCall, context: agentContext }));

    const activity = linearCalls().find((call) => call.operationName === "AgentActivityCreate");
    expect(activity?.input.content).toEqual({
      type: "action",
      action: "Run",
      parameter: "npm test",
    });
  });

  it("rejects a tool result above the shared cap", async () => {
    const response = await postToolCall(
      await sign({ ...validToolCall, result: "x".repeat(1001), context: agentContext })
    );

    expect(response.status).toBe(400);
  });
});
