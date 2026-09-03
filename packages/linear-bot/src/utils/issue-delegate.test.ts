import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSelfDelegate } from "./issue-delegate";
import type { LinearApiClient } from "./linear-client";

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

function sentGraphQL(): { operationName: string | undefined; variables: Record<string, unknown> } {
  const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as {
    query: string;
    variables: Record<string, unknown>;
  };
  return {
    operationName: /\bmutation\s+(\w+)/.exec(body.query)?.[1],
    variables: body.variables,
  };
}

describe("ensureSelfDelegate", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { issueUpdate: { success: true } } }))
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports already_self without calling Linear when the agent is the delegate", async () => {
    const result = await ensureSelfDelegate(client, {
      issueId: "issue-1",
      appUserId: "app-user-1",
      currentDelegateId: "app-user-1",
    });

    expect(result).toEqual({ outcome: "already_self" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves another delegate in place and reports who it is", async () => {
    const result = await ensureSelfDelegate(client, {
      issueId: "issue-1",
      appUserId: "app-user-1",
      currentDelegateId: "human-2",
    });

    expect(result).toEqual({ outcome: "delegated_to_other", delegateId: "human-2" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    "sets the agent as delegate through IssueSetDelegate when the delegate is %s",
    async (currentDelegateId) => {
      const result = await ensureSelfDelegate(client, {
        issueId: "issue-1",
        appUserId: "app-user-1",
        currentDelegateId,
      });

      expect(result).toEqual({ outcome: "set" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(sentGraphQL()).toEqual({
        operationName: "IssueSetDelegate",
        variables: { issueId: "issue-1", delegateId: "app-user-1" },
      });
    }
  );

  it("forwards the caller's abort signal to the GraphQL request", async () => {
    const controller = new AbortController();

    await ensureSelfDelegate(
      client,
      { issueId: "issue-1", appUserId: "app-user-1", currentDelegateId: null },
      controller.signal
    );

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports failed when Linear rejects the mutation", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ errors: [{ message: "Entity not found" }] }, { status: 400 })
    );

    const result = await ensureSelfDelegate(client, {
      issueId: "issue-1",
      appUserId: "app-user-1",
      currentDelegateId: null,
    });

    expect(result).toEqual({ outcome: "failed" });
  });

  it("reports failed when the mutation did not succeed", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ data: { issueUpdate: { success: false } } })
    );

    const result = await ensureSelfDelegate(client, {
      issueId: "issue-1",
      appUserId: "app-user-1",
      currentDelegateId: null,
    });

    expect(result).toEqual({ outcome: "failed" });
  });

  it("reports failed instead of throwing on a network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("network down"));

    await expect(
      ensureSelfDelegate(client, {
        issueId: "issue-1",
        appUserId: "app-user-1",
        currentDelegateId: null,
      })
    ).resolves.toEqual({ outcome: "failed" });
  });
});
