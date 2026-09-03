import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAppUserNotification,
  handleOAuthAppRevoked,
  handlePermissionChange,
} from "./notification-handler";
import { cancelPlanFrom } from "./plan";
import type { AppUserNotificationWebhook, Env } from "./types";
import {
  createFakeKV,
  createLinearFetchMock,
  linearClientCredentialsResponse,
  linearIdentityResponse,
  makeLinearBotEnv,
  storedClientCredentialsToken,
} from "./test-helpers";

interface LinearCall {
  operationName: string;
  variables: Record<string, unknown>;
}

function linearCalls(): LinearCall[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => String(input) === "https://api.linear.app/graphql")
    .map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      return {
        operationName: /\b(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "",
        variables: body.variables,
      };
    });
}

function activities(): Array<Record<string, unknown>> {
  return linearCalls()
    .filter((call) => call.operationName === "AgentActivityCreate")
    .map((call) => call.variables.input as Record<string, unknown>);
}

function controlPlaneFetch(env: Env) {
  return (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

function mapping(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: "session-xyz",
    issueId: "issue-1",
    issueIdentifier: "ENG-42",
    repoOwner: "acme",
    repoName: "backend",
    model: "anthropic/claude-haiku-4-5",
    agentSessionId: "agent-session-1",
    organizationId: "org-1",
    createdAt: Date.now(),
    ...overrides,
  });
}

function unassignedWebhook(
  overrides: Partial<AppUserNotificationWebhook["notification"]> = {},
  action = "issueUnassignedFromYou"
): AppUserNotificationWebhook {
  return {
    type: "AppUserNotification",
    action,
    organizationId: "org-1",
    appUserId: "app-user-1",
    webhookId: "webhook-1",
    notification: {
      id: "notification-1",
      type: action,
      issueId: "issue-1",
      issue: { id: "issue-1", identifier: "ENG-42" },
      actorId: "actor-1",
      ...overrides,
    },
  };
}

describe("handleAppUserNotification", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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

  it("stops the mapped session when the issue is unassigned from the agent", async () => {
    const { kv, store, putCalls } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "issue:issue-1": mapping(),
    });
    const env = makeLinearBotEnv(kv);
    const cpFetch = controlPlaneFetch(env);
    cpFetch.mockResolvedValue(Response.json({ status: "stopping" }));

    await handleAppUserNotification(unassignedWebhook(), env, "trace-unassigned");

    // The stop marker is written before anything else so an in-flight start aborts.
    expect(putCalls[0].key).toBe("stop:agent-session-1");
    expect(JSON.parse(putCalls[0].value)).toMatchObject({
      state: "requested",
      actorUserId: "actor-1",
      source: "unassigned",
    });

    expect(cpFetch).toHaveBeenCalledOnce();
    expect(cpFetch).toHaveBeenCalledWith(
      "https://internal/sessions/session-xyz/stop",
      expect.objectContaining({ method: "POST" })
    );
    const stopInit = cpFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(stopInit.headers).get("X-OpenInspect-Actor")).toBe("linear:actor-1");

    expect(store.has("issue:issue-1")).toBe(false);
    expect(activities()).toEqual([
      {
        agentSessionId: "agent-session-1",
        content: {
          type: "response",
          body: "The issue was unassigned from Open-Inspect, so the coding session was stopped.",
        },
      },
    ]);
    const planUpdate = linearCalls().find((call) => call.operationName === "AgentSessionUpdate");
    expect(planUpdate?.variables).toEqual({
      id: "agent-session-1",
      input: { plan: cancelPlanFrom("session_created") },
    });
    expect(JSON.parse(store.get("stop:agent-session-1") ?? "null")).toMatchObject({
      state: "confirmed",
      actorUserId: "actor-1",
      source: "unassigned",
    });
  });

  it("falls back to the nested actor id and omits the actor header when there is none", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "issue:issue-1": mapping(),
    });
    const env = makeLinearBotEnv(kv);
    const cpFetch = controlPlaneFetch(env);
    cpFetch.mockResolvedValue(Response.json({ status: "stopping" }));

    await handleAppUserNotification(
      unassignedWebhook({ actorId: undefined, actor: { id: "nested-actor" } }),
      env,
      "trace-nested-actor"
    );
    const nestedInit = cpFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(nestedInit.headers).get("X-OpenInspect-Actor")).toBe("linear:nested-actor");

    cpFetch.mockClear();
    const { kv: kv2, store: store2 } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "issue:issue-1": mapping(),
    });
    const env2 = makeLinearBotEnv(kv2);
    controlPlaneFetch(env2).mockResolvedValue(Response.json({ status: "stopping" }));

    await handleAppUserNotification(
      unassignedWebhook({ actorId: null, actor: null }),
      env2,
      "trace-no-actor"
    );

    const systemInit = controlPlaneFetch(env2).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(systemInit.headers).has("X-OpenInspect-Actor")).toBe(false);
    expect(store2.has("issue:issue-1")).toBe(false);
  });

  it("does nothing beyond logging when no session is mapped to the issue", async () => {
    const { kv, putCalls } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
    });
    const env = makeLinearBotEnv(kv);

    await handleAppUserNotification(unassignedWebhook(), env, "trace-no-mapping");

    expect(controlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(putCalls).toEqual([]);
    expect(activities()).toEqual([]);
  });

  it("skips an unassignment that names no issue", async () => {
    const { kv } = createFakeKV({ "issue:issue-1": mapping() });
    const env = makeLinearBotEnv(kv);

    await handleAppUserNotification(
      unassignedWebhook({ issueId: undefined, issue: undefined }),
      env,
      "trace-no-issue"
    );

    expect(kv.get).not.toHaveBeenCalled();
    expect(controlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it.each(["issueAssignedToYou", "issueCommentMention", "issueEmojiReaction", "issueNewComment"])(
    "only logs a %s notification",
    async (action) => {
      const { kv } = createFakeKV({ "issue:issue-1": mapping() });
      const env = makeLinearBotEnv(kv);

      await handleAppUserNotification(unassignedWebhook({}, action), env, "trace-other");

      expect(kv.get).not.toHaveBeenCalled();
      expect(kv.put).not.toHaveBeenCalled();
      expect(controlPlaneFetch(env)).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("reports a stop failure and keeps the mapping and request marker", async () => {
    const { kv, store } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "issue:issue-1": mapping(),
    });
    const env = makeLinearBotEnv(kv);
    controlPlaneFetch(env).mockResolvedValue(new Response("boom", { status: 500 }));

    await handleAppUserNotification(unassignedWebhook(), env, "trace-stop-failed");

    expect(store.has("issue:issue-1")).toBe(true);
    expect(activities()).toHaveLength(1);
    expect(activities()[0].content).toMatchObject({ type: "error" });
    expect(String((activities()[0].content as { body: string }).body)).toContain("HTTP 500");
    expect(linearCalls().some((call) => call.operationName === "AgentSessionUpdate")).toBe(false);
    expect(JSON.parse(store.get("stop:agent-session-1") ?? "null")).toMatchObject({
      state: "requested",
    });
  });

  it("stops a legacy mapping without an agent session silently", async () => {
    const { kv, store, putCalls } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "issue:issue-1": mapping({ agentSessionId: undefined }),
    });
    const env = makeLinearBotEnv(kv);
    controlPlaneFetch(env).mockResolvedValue(Response.json({ status: "stopping" }));

    await handleAppUserNotification(unassignedWebhook(), env, "trace-legacy-mapping");

    expect(controlPlaneFetch(env)).toHaveBeenCalledOnce();
    expect(store.has("issue:issue-1")).toBe(false);
    expect(putCalls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("handlePermissionChange", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only logs the team access change", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);

    await handlePermissionChange(
      {
        type: "PermissionChange",
        action: "teamAccessChanged",
        organizationId: "org-1",
        appUserId: "app-user-1",
        canAccessAllPublicTeams: false,
        addedTeamIds: ["team-1"],
        removedTeamIds: ["team-2", "team-3"],
      },
      env,
      "trace-permission"
    );

    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(controlPlaneFetch(env)).not.toHaveBeenCalled();
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: "permission.team_access_changed",
        trace_id: "trace-permission",
        added_count: 1,
        removed_count: 2,
      })
    );
  });
});

describe("handleOAuthAppRevoked", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const revoked = {
    type: "OAuthApp" as const,
    action: "revoked" as const,
    organizationId: "org-1",
  };

  it("drops the workspace credentials and its issue mappings, keeping other workspaces", async () => {
    const { kv, store } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "oauth:token:org-1": JSON.stringify({ refresh_token: "legacy" }),
      "oauth:client-credentials:org-2": storedClientCredentialsToken({ organization_id: "org-2" }),
      "issue:issue-1": mapping(),
      "issue:issue-2": mapping({ issueId: "issue-2", sessionId: "session-2" }),
      "issue:issue-other-org": mapping({ issueId: "issue-other-org", organizationId: "org-2" }),
      "issue:issue-legacy": mapping({ issueId: "issue-legacy", organizationId: undefined }),
      "config:project-repos": "{}",
    });
    const env = makeLinearBotEnv(kv);

    await handleOAuthAppRevoked(revoked, env, "trace-revoked");

    expect(store.has("oauth:client-credentials:org-1")).toBe(false);
    expect(store.has("oauth:token:org-1")).toBe(false);
    expect(store.has("oauth:client-credentials:org-2")).toBe(true);
    expect(store.has("issue:issue-1")).toBe(false);
    expect(store.has("issue:issue-2")).toBe(false);
    expect(store.has("issue:issue-other-org")).toBe(true);
    expect(store.has("issue:issue-legacy")).toBe(true);
    expect(store.has("config:project-repos")).toBe(true);
    expect(kv.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "issue:" }));
  });

  it("still clears credentials when listing mappings fails", async () => {
    const { kv, store } = createFakeKV({
      "oauth:client-credentials:org-1": storedClientCredentialsToken(),
      "issue:issue-1": mapping(),
    });
    vi.mocked(kv.list).mockRejectedValue(new Error("KV unavailable"));
    const env = makeLinearBotEnv(kv);

    await expect(
      handleOAuthAppRevoked(revoked, env, "trace-revoked-fail")
    ).resolves.toBeUndefined();

    expect(store.has("oauth:client-credentials:org-1")).toBe(false);
    expect(store.has("issue:issue-1")).toBe(true);
  });
});
