/**
 * Linear API client utilities — OAuth + raw GraphQL.
 */

import {
  linearIssueDetailsResponseSchema,
  linearRepoSuggestionsResponseSchema,
  linearUserResponseSchema,
  type Env,
  type LinearIssueDetails,
} from "../types";
import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared/auth";
import { createLogger } from "../logger";
import {
  getClientCredentialsTokenOrThrow,
  LINEAR_CLIENT_CREDENTIALS_SCOPE,
  LinearAuthError,
} from "./linear-credentials";
import { z } from "zod";
import { abortable } from "./abortable";

export {
  completeLinearOAuthInstallation,
  getClientCredentialsTokenOrThrow,
  LinearAuthError,
} from "./linear-credentials";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_GRAPHQL_TIMEOUT_MS = 15_000;

const linearCommentCreateResponseSchema = z.object({
  data: z
    .object({
      commentCreate: z
        .object({
          success: z.boolean(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const linearGraphQLErrorSchema = z.object({
  message: z.string().optional(),
});

const linearGraphQLResponseSchema = z
  .object({
    errors: z.array(linearGraphQLErrorSchema).optional(),
  })
  .passthrough();

/**
 * Best-effort extraction of the first GraphQL error message from a non-OK
 * response so validation failures (HTTP 400) are diagnosable from logs.
 */
async function readGraphQLErrorDetail(res: Response): Promise<string | null> {
  try {
    const parsed = linearGraphQLResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const message = parsed.data.errors?.[0]?.message;
    return message ? message.slice(0, 200) : null;
  } catch {
    return null;
  }
}

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

export function buildOAuthAuthorizeUrl(env: Env): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", LINEAR_CLIENT_CREDENTIALS_SCOPE);
  authUrl.searchParams.set("actor", "app");
  return authUrl.toString();
}

// ─── Linear API Client ──────────────────────────────────────────────────────

export interface LinearApiClient {
  accessToken: string;
  organizationId: string;
  renewAccessToken: () => Promise<string>;
}

export async function getLinearClient(
  env: Env,
  orgId: string,
  expectedAppUserId: string
): Promise<LinearApiClient | null> {
  try {
    return await getLinearClientOrThrow(env, orgId, expectedAppUserId);
  } catch (err) {
    if (err instanceof LinearAuthError) return null;
    throw err;
  }
}

export async function getLinearClientOrThrow(
  env: Env,
  orgId: string,
  expectedAppUserId: string
): Promise<LinearApiClient> {
  return {
    accessToken: await getClientCredentialsTokenOrThrow(env, orgId, { expectedAppUserId }),
    organizationId: orgId,
    renewAccessToken: () =>
      getClientCredentialsTokenOrThrow(env, orgId, {
        forceRenew: true,
        expectedAppUserId,
      }),
  };
}

/**
 * Execute a GraphQL query against the Linear API.
 */
export async function linearGraphQL(
  client: LinearApiClient,
  query: string,
  variables: Record<string, unknown>,
  callerSignal?: AbortSignal
): Promise<Record<string, unknown>> {
  const deadlineSignal = AbortSignal.timeout(LINEAR_GRAPHQL_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadlineSignal]) : deadlineSignal;
  const body = JSON.stringify({ query, variables });
  const send = (accessToken: string) =>
    fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body,
      signal,
    });

  let res = await send(client.accessToken);
  if (res.status === 401) {
    log.warn("linear.graphql.unauthorized", { org_id: client.organizationId });
    let renewedToken: string;
    try {
      renewedToken = await abortable(client.renewAccessToken(), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof LinearAuthError) throw error;
      throw new LinearAuthError({ reason: "client_credentials_error" });
    }
    client.accessToken = renewedToken;
    res = await send(renewedToken);
    if (res.status === 401) {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
      throw new LinearAuthError({
        reason: "client_credentials_rejected",
        status: res.status,
      });
    }
    if (res.ok) {
      log.info("linear.graphql.retry_succeeded", {
        org_id: client.organizationId,
        status: res.status,
      });
    } else {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
    }
  }

  if (!res.ok) {
    const detail = await readGraphQLErrorDetail(res);
    throw new Error(`Linear API error: ${res.status}${detail ? ` (${detail})` : ""}`);
  }

  const parsed = linearGraphQLResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error("Linear GraphQL error: unexpected response shape");
  }
  const json = parsed.data;

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msg = json.errors[0]?.message ?? "Unknown GraphQL error";
    throw new Error(`Linear GraphQL error: ${msg}`);
  }

  return json;
}

// ─── Agent Activities ────────────────────────────────────────────────────────

/**
 * The five activity shapes Linear accepts from an agent. Validated server-side;
 * `action` carries `action`/`parameter` (never `body`), everything else a `body`.
 */
export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/** Agent-to-human signals. Both apply to `elicitation` activities only. */
export type AgentActivitySignalInput =
  | {
      signal: "select";
      signalMetadata: { options: Array<{ label?: string; value: string }> };
    }
  | {
      signal: "auth";
      signalMetadata: { url: string; userId?: string; providerName?: string };
    };

export interface EmitAgentActivityOptions {
  /** Only `thought` and `action` may be ephemeral; ignored (and logged) otherwise. */
  ephemeral?: boolean;
  /** Only `elicitation` may carry a signal; ignored (and logged) otherwise. */
  signal?: AgentActivitySignalInput;
}

/**
 * Body substituted when a caller hands us an empty string. Linear accepts an
 * empty body but renders nothing, which is indistinguishable from the agent
 * never having answered — the failure mode behind "stuck in working".
 */
export const EMPTY_ACTIVITY_BODY_FALLBACK = "(The agent finished without producing a summary.)";

/**
 * Coerce an activity into a shape Linear will accept, logging anything dropped.
 * Exported for tests.
 */
export function normalizeAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  options?: EmitAgentActivityOptions
): {
  content: AgentActivityContent;
  ephemeral?: boolean;
  signal?: AgentActivitySignalInput["signal"];
  signalMetadata?: AgentActivitySignalInput["signalMetadata"];
} {
  let normalized: AgentActivityContent = content;
  if (content.type !== "action" && content.body.trim().length === 0) {
    log.warn("linear.emit_activity_invalid", {
      agent_session_id: agentSessionId,
      activity_type: content.type,
      reason: "empty_body",
    });
    normalized = { ...content, body: EMPTY_ACTIVITY_BODY_FALLBACK };
  }

  const canBeEphemeral = content.type === "thought" || content.type === "action";
  let ephemeral: boolean | undefined = options?.ephemeral;
  if (ephemeral && !canBeEphemeral) {
    log.warn("linear.emit_activity_invalid", {
      agent_session_id: agentSessionId,
      activity_type: content.type,
      reason: "ephemeral_not_allowed",
    });
    ephemeral = undefined;
  }

  let signal = options?.signal;
  if (signal && content.type !== "elicitation") {
    log.warn("linear.emit_activity_invalid", {
      agent_session_id: agentSessionId,
      activity_type: content.type,
      reason: "signal_not_allowed",
      signal: signal.signal,
    });
    signal = undefined;
  }

  return {
    content: normalized,
    ...(ephemeral ? { ephemeral } : {}),
    ...(signal ? { signal: signal.signal, signalMetadata: signal.signalMetadata } : {}),
  };
}

export async function emitAgentActivity(
  client: LinearApiClient,
  agentSessionId: string,
  content: AgentActivityContent,
  options?: EmitAgentActivityOptions
): Promise<boolean> {
  const normalized = normalizeAgentActivity(agentSessionId, content, options);
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `,
      {
        input: { agentSessionId, ...normalized },
      }
    );
    return true;
  } catch (err) {
    log.error("linear.emit_activity_failed", {
      agent_session_id: agentSessionId,
      activity_type: content.type,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

// ─── Issue Details ───────────────────────────────────────────────────────────

/**
 * Fetch full issue details from Linear API.
 */
export async function fetchIssueDetails(
  client: LinearApiClient,
  issueId: string
): Promise<LinearIssueDetails | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query IssueDetails($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          priorityLabel
          labels { nodes { id name } }
          project { id name }
          assignee { id name }
          delegate { id name }
          team { id key name }
          comments(first: 10, orderBy: createdAt) {
            nodes {
              body
              user { name }
            }
          }
        }
      }
    `,
      { id: issueId }
    );

    const parsed = linearIssueDetailsResponseSchema.safeParse(data);
    if (!parsed.success) return null;

    const issue = parsed.data.data?.issue;
    if (!issue) return null;

    return issue;
  } catch (err) {
    log.error("linear.fetch_issue_details", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Agent Session Management ────────────────────────────────────────────────

/**
 * Update an agent session (externalUrls, plan, etc.)
 */
export async function updateAgentSession(
  client: LinearApiClient,
  agentSessionId: string,
  input: Record<string, unknown>
): Promise<void> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }
    `,
      { id: agentSessionId, input }
    );
  } catch (err) {
    log.error("linear.update_session_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Use Linear's built-in repo suggestion API for issue→repo matching.
 */
export async function getRepoSuggestions(
  client: LinearApiClient,
  issueId: string,
  agentSessionId: string,
  candidateRepos: Array<{ hostname: string; repositoryFullName: string }>
): Promise<Array<{ repositoryFullName: string; confidence: number }>> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query RepoSuggestions($issueId: String!, $agentSessionId: String!, $candidateRepositories: [CandidateRepository!]!) {
        issueRepositorySuggestions(
          issueId: $issueId
          agentSessionId: $agentSessionId
          candidateRepositories: $candidateRepositories
        ) {
          suggestions {
            repositoryFullName
            confidence
          }
        }
      }
    `,
      { issueId, agentSessionId, candidateRepositories: candidateRepos }
    );

    const parsed = linearRepoSuggestionsResponseSchema.safeParse(data);
    if (!parsed.success) return [];

    return parsed.data.data?.issueRepositorySuggestions?.suggestions || [];
  } catch (err) {
    log.error("linear.repo_suggestions_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

// ─── Agent Session Activities ───────────────────────────────────────────────

export type AgentSessionActivityKind =
  | "prompt"
  | "response"
  | "error"
  | "elicitation"
  | "thought"
  | "action";

export interface AgentSessionActivity {
  id: string;
  createdAt: string;
  ephemeral: boolean;
  signal: string | null;
  kind: AgentSessionActivityKind;
  body: string;
}

/** Newest activities fetched when reconstructing a session's conversation. */
export const MAX_HISTORY_ACTIVITIES = 50;

const activityContentSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("AgentActivityPromptContent"), body: z.string() }),
  z.object({ __typename: z.literal("AgentActivityResponseContent"), body: z.string() }),
  z.object({ __typename: z.literal("AgentActivityErrorContent"), body: z.string() }),
  z.object({ __typename: z.literal("AgentActivityElicitationContent"), body: z.string() }),
  z.object({ __typename: z.literal("AgentActivityThoughtContent"), body: z.string() }),
  z.object({
    __typename: z.literal("AgentActivityActionContent"),
    action: z.string(),
    parameter: z.string().nullable().optional(),
    result: z.string().nullable().optional(),
  }),
]);

const agentSessionActivitiesResponseSchema = z.object({
  data: z
    .object({
      agentSession: z
        .object({
          activities: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                createdAt: z.string(),
                ephemeral: z.boolean().nullable().optional(),
                signal: z.string().nullable().optional(),
                content: activityContentSchema,
              })
            ),
          }),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

const ACTIVITY_KIND_BY_TYPENAME: Record<string, AgentSessionActivityKind> = {
  AgentActivityPromptContent: "prompt",
  AgentActivityResponseContent: "response",
  AgentActivityErrorContent: "error",
  AgentActivityElicitationContent: "elicitation",
  AgentActivityThoughtContent: "thought",
  AgentActivityActionContent: "action",
};

/**
 * Fetch the newest activities of an agent session, oldest first. Linear's
 * guidance is to rebuild conversations from these frozen snapshots rather
 * than from editable comments. Returns `[]` on any failure.
 */
export async function fetchAgentSessionActivities(
  client: LinearApiClient,
  agentSessionId: string,
  signal?: AbortSignal
): Promise<AgentSessionActivity[]> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query AgentSessionActivities($id: String!, $last: Int!) {
        agentSession(id: $id) {
          activities(last: $last, orderBy: createdAt) {
            nodes {
              id
              createdAt
              ephemeral
              signal
              content {
                __typename
                ... on AgentActivityPromptContent { body }
                ... on AgentActivityResponseContent { body }
                ... on AgentActivityErrorContent { body }
                ... on AgentActivityElicitationContent { body }
                ... on AgentActivityThoughtContent { body }
                ... on AgentActivityActionContent { action parameter result }
              }
            }
          }
        }
      }
    `,
      { id: agentSessionId, last: MAX_HISTORY_ACTIVITIES },
      signal
    );

    const parsed = agentSessionActivitiesResponseSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("linear.fetch_activities_malformed", { agent_session_id: agentSessionId });
      return [];
    }
    const nodes = parsed.data.data?.agentSession?.activities.nodes ?? [];
    return nodes.map((node) => {
      const content = node.content;
      const body =
        content.__typename === "AgentActivityActionContent"
          ? [content.action, content.parameter, content.result].filter(Boolean).join(" ")
          : content.body;
      return {
        id: node.id,
        createdAt: node.createdAt,
        ephemeral: node.ephemeral ?? false,
        signal: node.signal ?? null,
        kind: ACTIVITY_KIND_BY_TYPENAME[content.__typename] ?? "thought",
        body,
      };
    });
  } catch (err) {
    log.error("linear.fetch_activities_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

// ─── User Lookup ────────────────────────────────────────────────────────────

/**
 * Fetch a Linear user by ID. Returns name and email for identity linking.
 */
export async function fetchUser(
  client: LinearApiClient,
  userId: string
): Promise<{ id: string; name: string; email: string | null } | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query FetchUser($id: String!) {
        user(id: $id) {
          id
          name
          email
        }
      }
    `,
      { id: userId }
    );

    const parsed = linearUserResponseSchema.safeParse(data);
    if (!parsed.success) return null;

    const user = parsed.data.data?.user;
    if (!user) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email ?? null,
    };
  } catch (err) {
    log.error("linear.fetch_user", {
      user_id: userId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Webhook Verification ────────────────────────────────────────────────────

export async function verifyLinearWebhook(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;
  const expectedHex = await computeHmacHex(body, secret);
  return timingSafeEqual(signature, expectedHex);
}

// ─── Comment Posting (fallback) ──────────────────────────────────────────────

export async function postIssueComment(
  apiKey: string,
  issueId: string,
  body: string
): Promise<{ success: boolean }> {
  try {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: `
          mutation CommentCreate($input: CommentCreateInput!) {
            commentCreate(input: $input) { success }
          }
        `,
        variables: { input: { issueId, body } },
      }),
      signal: AbortSignal.timeout(LINEAR_GRAPHQL_TIMEOUT_MS),
    });

    if (!response.ok) return { success: false };
    const result = linearCommentCreateResponseSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!result.success) return { success: false };
    return { success: result.data.data?.commentCreate?.success ?? false };
  } catch {
    return { success: false };
  }
}
