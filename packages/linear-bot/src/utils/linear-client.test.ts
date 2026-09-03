import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_ACTIVITY_BODY_FALLBACK,
  emitAgentActivity,
  fetchAgentSessionActivities,
  fetchIssueDetails,
  fetchUser,
  getRepoSuggestions,
  LINEAR_GRAPHQL_TIMEOUT_MS,
  linearGraphQL,
  MAX_HISTORY_ACTIVITIES,
  postIssueComment,
} from "./linear-client";
import type { LinearApiClient } from "./linear-client";

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

describe("linearGraphQL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a GraphQL response that is not an object", async () => {
    mockFetchResponse([]);

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toThrow(
      "Linear GraphQL error: unexpected response shape"
    );
  });

  it("rejects a null GraphQL response", async () => {
    mockFetchResponse(null);

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toThrow(
      "Linear GraphQL error: unexpected response shape"
    );
  });

  it("includes the GraphQL error message when the API rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            errors: [{ message: 'Unknown type "IssueRepositorySuggestionInput".' }],
          }),
      })
    );

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toThrow(
      'Linear API error: 400 (Unknown type "IssueRepositorySuggestionInput".)'
    );
  });

  it("reports a bare status when a rejected response has no GraphQL body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error("not json")),
      })
    );

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toThrow(
      "Linear API error: 502"
    );
  });

  it("returns the envelope for a well-formed GraphQL response", async () => {
    mockFetchResponse({ data: { viewer: { id: "user-1" } } });

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).resolves.toEqual({
      data: { viewer: { id: "user-1" } },
    });
  });

  it("times out the first GraphQL attempt", async () => {
    const timeoutSignal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        expect(init?.signal).toBe(timeoutSignal);
        throw timeoutSignal.reason;
      })
    );

    await expect(linearGraphQL(client, "query { viewer { id } }", {})).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(LINEAR_GRAPHQL_TIMEOUT_MS);
  });

  it("uses the same deadline for a renewed-token retry", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const renewAccessToken = vi.fn(async () => "renewed-token");
    const retryClient: LinearApiClient = {
      accessToken: "expired-token",
      organizationId: "org-1",
      renewAccessToken,
    };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(deadline.signal);
      if (fetchMock.mock.calls.length === 1) return new Response(null, { status: 401 });
      deadline.abort(new DOMException("timed out", "TimeoutError"));
      throw deadline.signal.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(linearGraphQL(retryClient, "query { viewer { id } }", {})).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(renewAccessToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the aggregate timeout while token renewal is stalled", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let renewalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    const renewAccessToken = vi.fn(
      () =>
        new Promise<string>(() => {
          renewalStarted?.();
        })
    );
    const renewalClient: LinearApiClient = {
      accessToken: "expired-token",
      organizationId: "org-1",
      renewAccessToken,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 }))
    );

    const request = linearGraphQL(renewalClient, "query { viewer { id } }", {});
    await started;
    deadline.abort(new DOMException("timed out", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    expect(renewAccessToken).toHaveBeenCalledOnce();
  });
});

describe("fetchUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns user with name and email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-1", name: "Alice", email: "alice@example.com" },
      },
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toEqual({
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("returns null email when user has no email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-2", name: "Bob", email: null },
      },
    });

    const result = await fetchUser(client, "user-2");
    expect(result).toEqual({
      id: "user-2",
      name: "Bob",
      email: null,
    });
  });

  it("returns null when user is not found", async () => {
    mockFetchResponse({ data: { user: null } });

    const result = await fetchUser(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null on GraphQL errors payload", async () => {
    mockFetchResponse({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null when the user payload is malformed", async () => {
    mockFetchResponse({ data: { user: { id: "user-1", email: "alice@example.com" } } });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });
});

describe("fetchIssueDetails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns issue details with nullable fields", async () => {
    mockFetchResponse({
      data: {
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Fix bug",
          description: null,
          url: "https://linear.app/acme/issue/ENG-1",
          priority: 2,
          priorityLabel: "High",
          labels: { nodes: [{ id: "label-1", name: "bug" }] },
          project: null,
          assignee: null,
          team: { id: "team-1", key: "ENG", name: "Engineering" },
          comments: { nodes: [{ body: "please fix", user: null }] },
        },
      },
    });

    await expect(fetchIssueDetails(client, "issue-1")).resolves.toEqual({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix bug",
      description: null,
      url: "https://linear.app/acme/issue/ENG-1",
      priority: 2,
      priorityLabel: "High",
      labels: [{ id: "label-1", name: "bug" }],
      project: null,
      assignee: null,
      team: { id: "team-1", key: "ENG", name: "Engineering" },
      comments: [{ body: "please fix", user: null }],
    });
  });

  it("returns null when the issue payload is malformed", async () => {
    mockFetchResponse({ data: { issue: { id: "issue-1", title: "missing fields" } } });

    await expect(fetchIssueDetails(client, "issue-1")).resolves.toBeNull();
  });
});

describe("fetchIssueDetails delegate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const issue = {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Title",
    description: null,
    url: "https://linear.app/acme/issue/ENG-1",
    priority: 0,
    priorityLabel: "No priority",
    labels: { nodes: [] },
    project: null,
    assignee: null,
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    comments: { nodes: [] },
  };

  it("requests and returns the issue delegate", async () => {
    mockFetchResponse({
      data: { issue: { ...issue, delegate: { id: "app-user-1", name: "Open-Inspect" } } },
    });

    const details = await fetchIssueDetails(client, "issue-1");

    expect(details?.delegate).toEqual({ id: "app-user-1", name: "Open-Inspect" });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as { query: string };
    expect(body.query).toMatch(/delegate\s*\{\s*id\s+name\s*\}/);
  });

  it("accepts a null delegate", async () => {
    mockFetchResponse({ data: { issue: { ...issue, delegate: null } } });

    const details = await fetchIssueDetails(client, "issue-1");

    expect(details).not.toBeNull();
    expect(details?.delegate).toBeNull();
  });
});

describe("fetchAgentSessionActivities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function node(
    content: Record<string, unknown>,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id: "activity-1",
      createdAt: "2026-09-03T10:00:00.000Z",
      ephemeral: false,
      signal: null,
      content,
      ...overrides,
    };
  }

  function activitiesResponse(nodes: Array<Record<string, unknown>>) {
    return { data: { agentSession: { activities: { nodes } } } };
  }

  it("requests the newest activities of the session", async () => {
    mockFetchResponse(activitiesResponse([]));

    await fetchAgentSessionActivities(client, "agent-session-1");

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    expect(body.query).toContain("query AgentSessionActivities");
    expect(body.query).toContain("activities(last: $last, orderBy: createdAt)");
    expect(body.variables).toEqual({ id: "agent-session-1", last: MAX_HISTORY_ACTIVITIES });
  });

  it("maps every content type onto a kind and body", async () => {
    mockFetchResponse(
      activitiesResponse([
        node({ __typename: "AgentActivityPromptContent", body: "Fix it" }, { id: "a1" }),
        node({ __typename: "AgentActivityThoughtContent", body: "Hmm" }, { id: "a2" }),
        node({ __typename: "AgentActivityElicitationContent", body: "Which?" }, { id: "a3" }),
        node({ __typename: "AgentActivityResponseContent", body: "Done" }, { id: "a4" }),
        node({ __typename: "AgentActivityErrorContent", body: "Oops" }, { id: "a5" }),
      ])
    );

    const activities = await fetchAgentSessionActivities(client, "agent-session-1");

    expect(activities.map((a) => [a.id, a.kind, a.body])).toEqual([
      ["a1", "prompt", "Fix it"],
      ["a2", "thought", "Hmm"],
      ["a3", "elicitation", "Which?"],
      ["a4", "response", "Done"],
      ["a5", "error", "Oops"],
    ]);
    expect(activities[0]).toMatchObject({
      createdAt: "2026-09-03T10:00:00.000Z",
      ephemeral: false,
      signal: null,
    });
  });

  it("joins action rows from action, parameter and result, skipping blanks", async () => {
    mockFetchResponse(
      activitiesResponse([
        node(
          {
            __typename: "AgentActivityActionContent",
            action: "Run",
            parameter: "npm test",
            result: "12 passed",
          },
          { id: "a1" }
        ),
        node(
          { __typename: "AgentActivityActionContent", action: "Read", parameter: null },
          { id: "a2" }
        ),
        node({ __typename: "AgentActivityActionContent", action: "Search" }, { id: "a3" }),
      ])
    );

    const activities = await fetchAgentSessionActivities(client, "agent-session-1");

    expect(activities.map((a) => [a.kind, a.body])).toEqual([
      ["action", "Run npm test 12 passed"],
      ["action", "Read"],
      ["action", "Search"],
    ]);
  });

  it("defaults missing ephemeral and signal fields", async () => {
    mockFetchResponse(
      activitiesResponse([
        node(
          { __typename: "AgentActivityPromptContent", body: "stop" },
          { ephemeral: null, signal: "stop" }
        ),
        node(
          { __typename: "AgentActivityThoughtContent", body: "..." },
          { ephemeral: true, signal: undefined }
        ),
      ])
    );

    const activities = await fetchAgentSessionActivities(client, "agent-session-1");

    expect(activities[0]).toMatchObject({ ephemeral: false, signal: "stop" });
    expect(activities[1]).toMatchObject({ ephemeral: true, signal: null });
  });

  it("returns an empty list when the session is missing", async () => {
    mockFetchResponse({ data: { agentSession: null } });

    await expect(fetchAgentSessionActivities(client, "agent-session-1")).resolves.toEqual([]);
  });

  it("returns an empty list when the payload is malformed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchResponse(
      activitiesResponse([node({ __typename: "AgentActivityUnknownContent", body: "?" })])
    );

    await expect(fetchAgentSessionActivities(client, "agent-session-1")).resolves.toEqual([]);
  });

  it("returns an empty list on a GraphQL error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetchResponse({ errors: [{ message: "Entity not found" }] });

    await expect(fetchAgentSessionActivities(client, "agent-session-1")).resolves.toEqual([]);
  });

  it("returns an empty list on an HTTP failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    await expect(fetchAgentSessionActivities(client, "agent-session-1")).resolves.toEqual([]);
  });

  it("forwards the caller's abort signal", async () => {
    mockFetchResponse(activitiesResponse([]));
    const controller = new AbortController();

    await fetchAgentSessionActivities(client, "agent-session-1", controller.signal);

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getRepoSuggestions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed repo suggestions", async () => {
    mockFetchResponse({
      data: {
        issueRepositorySuggestions: {
          suggestions: [{ repositoryFullName: "acme/api", confidence: 0.92 }],
        },
      },
    });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([
      { repositoryFullName: "acme/api", confidence: 0.92 },
    ]);
  });

  it("declares the candidateRepositories variable with Linear's CandidateRepository input type", async () => {
    mockFetchResponse({ data: { issueRepositorySuggestions: { suggestions: [] } } });

    await getRepoSuggestions(client, "issue-1", "agent-1", [
      { hostname: "github.com", repositoryFullName: "acme/api" },
    ]);

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    expect(body.query).toContain("$candidateRepositories: [CandidateRepository!]!");
    expect(body.query).not.toContain("IssueRepositorySuggestionInput");
    expect(body.variables).toEqual({
      issueId: "issue-1",
      agentSessionId: "agent-1",
      candidateRepositories: [{ hostname: "github.com", repositoryFullName: "acme/api" }],
    });
  });

  it("returns an empty list when suggestions are null", async () => {
    mockFetchResponse({ data: { issueRepositorySuggestions: null } });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([]);
  });

  it("returns an empty list when suggestions are malformed", async () => {
    mockFetchResponse({
      data: { issueRepositorySuggestions: { suggestions: [{ repositoryFullName: "acme/api" }] } },
    });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([]);
  });
});

describe("emitAgentActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a failed terminal activity delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(
      emitAgentActivity(client, "agent-session-1", {
        type: "response",
        body: "Finished",
      })
    ).resolves.toBe(false);
  });
});

describe("emitAgentActivity payload shaping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function sentInput(): Record<string, unknown> {
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as { variables: { input: Record<string, unknown> } };
    return body.variables.input;
  }

  it("serializes a select signal on an elicitation", async () => {
    mockFetchResponse({ data: { agentActivityCreate: { success: true } } });

    await emitAgentActivity(
      client,
      "agent-session-1",
      { type: "elicitation", body: "Which repository?" },
      {
        signal: {
          signal: "select",
          signalMetadata: { options: [{ value: "acme/api" }, { value: "acme/web" }] },
        },
      }
    );

    expect(sentInput()).toEqual({
      agentSessionId: "agent-session-1",
      content: { type: "elicitation", body: "Which repository?" },
      signal: "select",
      signalMetadata: { options: [{ value: "acme/api" }, { value: "acme/web" }] },
    });
  });

  it("drops ephemeral from a response and a signal from a thought", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchResponse({ data: { agentActivityCreate: { success: true } } });

    await emitAgentActivity(
      client,
      "agent-session-1",
      { type: "response", body: "Done" },
      { ephemeral: true, signal: { signal: "select", signalMetadata: { options: [] } } }
    );

    expect(sentInput()).toEqual({
      agentSessionId: "agent-session-1",
      content: { type: "response", body: "Done" },
    });
  });

  it("keeps ephemeral on thoughts and actions", async () => {
    mockFetchResponse({ data: { agentActivityCreate: { success: true } } });

    await emitAgentActivity(
      client,
      "agent-session-1",
      { type: "action", action: "Run", parameter: "npm test", result: "12 passed" },
      { ephemeral: true }
    );

    expect(sentInput()).toEqual({
      agentSessionId: "agent-session-1",
      content: { type: "action", action: "Run", parameter: "npm test", result: "12 passed" },
      ephemeral: true,
    });
  });

  it("never sends an empty body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchResponse({ data: { agentActivityCreate: { success: true } } });

    await emitAgentActivity(client, "agent-session-1", { type: "response", body: "   " });

    expect(sentInput()).toEqual({
      agentSessionId: "agent-session-1",
      content: { type: "response", body: EMPTY_ACTIVITY_BODY_FALLBACK },
    });
  });
});

describe("postIssueComment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns success from a valid comment mutation response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: { success: true } } }),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: true,
    });
  });

  it("returns false when the nullable comment mutation result is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: null } }),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });

  it("returns false when the comment mutation response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { commentCreate: { success: "yes" } } }),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });

  it("returns false when the comment mutation response is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });

  it("returns false when the comment request times out", async () => {
    const timeoutSignal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        expect(init?.signal).toBe(timeoutSignal);
        throw timeoutSignal.reason;
      })
    );

    await expect(postIssueComment("token", "issue-1", "hello")).resolves.toEqual({
      success: false,
    });
  });
});
