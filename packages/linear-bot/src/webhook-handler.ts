/**
 * Agent session event handler — orchestrates issue→session lifecycle.
 * Extracted from index.ts for modularity.
 */

import {
  createSessionResponseSchema,
  type LinearCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { z } from "zod";
import type {
  Env,
  LinearIssueDetails,
  AgentSessionWebhook,
  AgentSessionWebhookIssue,
} from "./types";
import {
  getLinearClient,
  getLinearClientOrThrow,
  LinearAuthError,
  emitAgentActivity,
  fetchAgentSessionActivities,
  fetchIssueDetails,
  fetchUser,
  updateAgentSession,
} from "./utils/linear-client";
import { ensureSelfDelegate } from "./utils/issue-delegate";
import {
  historyHasAgentTurn,
  selectConversationHistory,
  type ConversationTurn,
} from "./conversation-history";
import { resolveAppName } from "@open-inspect/shared/app-name";
import type { LinearApiClient } from "./utils/linear-client";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";
import { cancelPlanFrom, createPlanTracker, makePlan, setPlan, type PlanTracker } from "./plan";
import {
  assertNotStopped,
  clearStopMarker,
  markStopConfirmed,
  markStopRequested,
  readStopMarker,
  StopRequestedError,
} from "./stop-marker";
import { extractModelFromLabels, resolveSessionModelSettings } from "./model-resolution";
import {
  resolveSessionTarget,
  resolveStoredSessionTarget,
  resolveTargetIntegration,
  targetId,
  targetLabel,
  targetRequestFields,
  type SessionTarget,
} from "./target-resolution";
import {
  deleteIssueSession,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
  touchKeepalive,
} from "./kv-store";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import type { IssueSession } from "./types";

const log = createLogger("handler");

const sessionEventsSummaryResponseSchema = z.object({
  events: z.array(
    z.object({
      type: z.literal("token"),
      data: z.object({
        content: z.string(),
      }),
    })
  ),
});

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildUntrustedUserContentBlock(params: {
  source: string;
  author: string;
  content: string;
  note?: string;
}): string {
  const { source, author, content } = params;
  const escapedContent = content
    .replaceAll("<\\user_content", "<\\\\user_content")
    .replaceAll("<\\/user_content>", "<\\\\/user_content>")
    .replaceAll("<user_content", "<\\user_content")
    .replaceAll("</user_content>", "<\\/user_content>");

  return `<user_content source="${escapeHtml(source)}" author="${escapeHtml(author)}">
${escapedContent}
</user_content>`;
}

/**
 * Render earlier turns of the Linear agent session as untrusted context.
 * Exported for tests.
 */
export function renderConversationHistory(history: ConversationTurn[] | undefined): string[] {
  if (!history || history.length === 0) return [];
  return [
    "",
    "---",
    "**Earlier conversation on this Linear agent session (oldest first):**",
    ...history.map((turn) =>
      buildUntrustedUserContentBlock({
        source: `linear_agent_activity_${turn.kind}`,
        author: turn.kind === "prompt" ? "user" : "agent",
        content: turn.body,
        note: "the Linear agent session history",
      })
    ),
  ];
}

export function buildPromptContextPrompt(
  promptContext: string,
  conversationHistory?: ConversationTurn[]
): string {
  return [
    "Linear provided additional issue context below.",
    "",
    buildUntrustedUserContentBlock({
      source: "linear_prompt_context",
      author: "linear",
      content: promptContext,
    }),
    ...renderConversationHistory(conversationHistory),
    "",
  ].join("\n");
}

export function buildFollowUpPrompt(params: {
  issueIdentifier: string;
  followUpContent: string;
  followUpSource: string;
  followUpAuthor: string;
  sessionContextSummary?: string;
  conversationHistory?: ConversationTurn[];
}): string {
  const {
    issueIdentifier,
    followUpContent,
    followUpSource,
    followUpAuthor,
    sessionContextSummary,
    conversationHistory,
  } = params;

  return [
    `Follow-up on ${issueIdentifier}:`,
    "",
    buildUntrustedUserContentBlock({
      source: followUpSource,
      author: followUpAuthor,
      content: followUpContent,
    }),
    ...(sessionContextSummary
      ? [
          "",
          "---",
          "**Previous agent response (summary):**",
          buildUntrustedUserContentBlock({
            source: "linear_agent_response_summary",
            author: "agent",
            content: sessionContextSummary,
            note: "a previous agent response",
          }),
        ]
      : []),
    ...renderConversationHistory(conversationHistory),
  ].join("\n");
}

/**
 * Create a session via the control plane.
 */
async function createSession(
  env: Env,
  target: SessionTarget,
  params: {
    title: string;
    model: string;
    reasoningEffort?: string;
    actorUserId?: string;
    actorDisplayName?: string;
    actorEmail?: string;
  },
  traceId?: string
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; body: string }> {
  const url = "https://internal/sessions";
  const body = JSON.stringify({
    ...targetRequestFields(target),
    title: params.title,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    actorDisplayName: params.actorDisplayName,
    actorEmail: params.actorEmail,
  });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body,
    actor: params.actorUserId ? `linear:${params.actorUserId}` : undefined,
    traceId,
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    return { ok: false, status: response.status, body };
  }

  const result = createSessionResponseSchema.safeParse(await response.json().catch(() => null));
  if (!result.success) {
    return { ok: false, status: response.status, body: "invalid response" };
  }
  return { ok: true, sessionId: result.data.sessionId };
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function getAgentSessionLinearClient(params: {
  env: Env;
  traceId: string;
  orgId: string;
  agentSessionId: string;
  issue: AgentSessionWebhookIssue;
  mode: "start" | "follow_up";
  expectedAppUserId: string;
}): Promise<LinearApiClient | null> {
  const { env, traceId, orgId, agentSessionId, issue, mode, expectedAppUserId } = params;

  try {
    return await getLinearClientOrThrow(env, orgId, expectedAppUserId);
  } catch (err) {
    if (!(err instanceof LinearAuthError)) throw err;

    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      mode,
      auth_failure_reason: err.reason,
    });
    return null;
  }
}

/** Control-plane stop responses that mean the session is (already) not running. */
function stopSucceeded(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404 || status === 409;
}

function sessionLink(env: Env, sessionId: string): string {
  return `[View session](${env.WEB_APP_URL}/session/${sessionId})`;
}

/**
 * Stop the control-plane session mapped to `issueId` on behalf of a Linear
 * stop request. Shared by the `stop` signal handler and the
 * `issueUnassignedFromYou` notification handler.
 */
export async function stopMappedSession(params: {
  env: Env;
  traceId: string;
  mapping: IssueSession;
  /** Absent for system-initiated stops (the stop route accepts actorless bot calls). */
  actorUserId?: string;
}): Promise<{ ok: true } | { ok: false; status?: number }> {
  const { env, traceId, mapping, actorUserId } = params;
  try {
    const stopRes = await signedControlPlaneFetch(env, {
      method: "POST",
      url: `https://internal/sessions/${mapping.sessionId}/stop`,
      actor: actorUserId ? `linear:${actorUserId}` : undefined,
      traceId,
    });
    if (!stopSucceeded(stopRes.status)) {
      log.error("agent_session.stop_failed", {
        trace_id: traceId,
        session_id: mapping.sessionId,
        stop_status: stopRes.status,
      });
      return { ok: false, status: stopRes.status };
    }
    await deleteIssueSession(env, mapping.issueId);
    log.info("agent_session.stopped", {
      trace_id: traceId,
      session_id: mapping.sessionId,
      issue_id: mapping.issueId,
      stop_status: stopRes.status,
    });
    return { ok: true };
  } catch (e) {
    log.error("agent_session.stop_failed", {
      trace_id: traceId,
      session_id: mapping.sessionId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return { ok: false };
  }
}

/**
 * Handle a user's stop request. Per the Linear agent spec the agent must halt
 * immediately and then emit a final `response` (or `error`) confirming what
 * happened — silence leaves the session showing "working".
 */
async function handleStop(webhook: AgentSessionWebhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;
  const actorUserId =
    webhook.agentActivity?.userId ?? webhook.agentSession.comment?.userId ?? undefined;

  const existingMarker = await readStopMarker(env, agentSessionId);
  if (existingMarker?.state === "confirmed") {
    log.info("agent_session.stop_duplicate", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  // Marker first: any in-flight new-session or follow-up flow for this agent
  // session aborts at its next checkpoint.
  await markStopRequested(env, agentSessionId, { actorUserId, source: "agent_activity" });

  const client = await getLinearClient(env, webhook.organizationId, webhook.appUserId);
  const say = async (content: { type: "response" | "error"; body: string }) => {
    if (client) await emitAgentActivity(client, agentSessionId, content);
  };

  const mapping = issue ? await lookupIssueSession(env, issue.id) : null;
  // A mapping that belongs to a newer agent session on the same issue is not
  // ours to stop.
  const ownMapping =
    mapping && (!mapping.agentSessionId || mapping.agentSessionId === agentSessionId)
      ? mapping
      : null;

  if (!ownMapping) {
    await say({
      type: "response",
      body: "Stopped. Nothing was running for this request, so there is nothing else to cancel.",
    });
    await markStopConfirmed(env, agentSessionId);
    log.info("agent_session.stop_handled", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      outcome: "no_session",
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  if (!actorUserId) {
    log.warn("Linear stop rejected because its author is missing", {
      event: "agent_session.stop_author_missing",
      agent_session_id: agentSessionId,
      issue_id: ownMapping.issueId,
      trace_id: traceId,
    });
    await say({
      type: "error",
      body: "Cannot stop the coding session because Linear did not identify who requested the stop.",
    });
    return;
  }

  const result = await stopMappedSession({ env, traceId, mapping: ownMapping, actorUserId });
  if (!result.ok) {
    await say({
      type: "error",
      body: `Failed to stop the coding session${result.status ? ` (HTTP ${result.status})` : ""}. It may still be running. ${sessionLink(env, ownMapping.sessionId)}`,
    });
    return;
  }

  await say({
    type: "response",
    body: `Stopped the coding session for \`${ownMapping.issueIdentifier}\`. ${sessionLink(env, ownMapping.sessionId)}`,
  });
  if (client) {
    await updateAgentSession(client, agentSessionId, {
      plan: cancelPlanFrom("session_created"),
    });
  }
  await markStopConfirmed(env, agentSessionId);

  log.info("agent_session.stop_handled", {
    trace_id: traceId,
    agent_session_id: agentSessionId,
    session_id: ownMapping.sessionId,
    issue_id: ownMapping.issueId,
    outcome: "stopped",
    duration_ms: Date.now() - startTime,
  });
}

/**
 * The comments and actor driving a new session. A "prompted" event that
 * reaches new-session handling is a reply to an elicitation — no
 * issue→session mapping existed, so no session was ever created. The reply
 * text lives on the agent activity and drives target resolution, while the
 * session comment remains the original instruction. Its author is the replier
 * — not necessarily the user whose comment created the elicitation.
 */
function getNewSessionInput(webhook: AgentSessionWebhook): {
  resolutionComment: { body: string } | undefined;
  instructionComment: { body: string } | undefined;
  clarificationReply: { body: string } | undefined;
  actorUserId: string | undefined;
} {
  const instructionComment = webhook.agentSession.comment;
  const sessionActor = instructionComment?.userId ?? webhook.agentSession.creatorId ?? undefined;
  const replyBody =
    webhook.action === "prompted" ? webhook.agentActivity?.content?.body?.trim() : undefined;
  if (replyBody) {
    const clarificationReply = { body: replyBody };
    return {
      resolutionComment: clarificationReply,
      instructionComment,
      clarificationReply,
      actorUserId: webhook.agentActivity?.userId ?? sessionActor,
    };
  }
  return {
    resolutionComment: instructionComment,
    instructionComment,
    clarificationReply: undefined,
    actorUserId: sessionActor,
  };
}

function shouldTransitionIssueOnStart(webhook: AgentSessionWebhook): boolean {
  return webhook.action === "created" && Boolean(webhook.agentSession.creatorId?.trim());
}

function getFollowUp(webhook: AgentSessionWebhook): {
  content: string;
  source: "linear_agent_activity" | "linear_comment" | "linear_fallback";
  actorUserId?: string;
} {
  const activityBody = webhook.agentActivity?.content?.body;
  if (activityBody) {
    return {
      content: activityBody,
      source: "linear_agent_activity",
      actorUserId: webhook.agentActivity?.userId ?? undefined,
    };
  }

  const comment = webhook.agentSession.comment;
  if (comment?.body) {
    return {
      content: comment.body,
      source: "linear_comment",
      actorUserId: comment.userId ?? undefined,
    };
  }

  return {
    content: "Follow-up on the issue.",
    source: "linear_fallback",
    actorUserId: undefined,
  };
}

function buildLinearCallbackContext(params: {
  webhook: AgentSessionWebhook;
  issue: AgentSessionWebhookIssue;
  model: string;
  repoFullName?: string;
  emitToolProgressActivities?: boolean;
  transitionIssueOnStart?: boolean;
}): LinearCallbackContext {
  const {
    webhook,
    issue,
    model,
    repoFullName,
    emitToolProgressActivities,
    transitionIssueOnStart,
  } = params;
  const context = {
    source: "linear" as const,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName,
    model,
    agentSessionId: webhook.agentSession.id,
    organizationId: webhook.organizationId,
    appUserId: webhook.appUserId,
    emitToolProgressActivities,
  };
  if (transitionIssueOnStart === true) {
    return { ...context, transitionIssueOnStart: true };
  }
  return {
    ...context,
    ...(transitionIssueOnStart === false ? { transitionIssueOnStart: false as const } : {}),
  };
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Forward a follow-up prompt to the existing control-plane session.
 * Returns `session_gone` when the control plane no longer accepts prompts for
 * it (cancelled or archived); the caller then starts a fresh session.
 */
async function handleFollowUp(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string,
  existingSession: IssueSession
): Promise<"handled" | "session_gone"> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const orgId = webhook.organizationId;
  const followUp = getFollowUp(webhook);

  const client = await getAgentSessionLinearClient({
    env,
    traceId,
    orgId,
    agentSessionId,
    issue,
    mode: "follow_up",
    expectedAppUserId: webhook.appUserId,
  });
  if (!client) return "handled";

  // Ack first: Linear expects the first activity within 10 s of the event.
  await emitAgentActivity(
    client,
    agentSessionId,
    { type: "thought", body: "Processing follow-up message..." },
    { ephemeral: true }
  );
  await assertNotStopped(env, agentSessionId, "after_ack");

  if (!followUp.actorUserId) {
    log.warn("Linear follow-up rejected because its author is missing", {
      event: "agent_session.follow_up_author_missing",
      agent_session_id: agentSessionId,
      issue_id: issue.id,
      organization_id: orgId,
      trace_id: traceId,
    });
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Cannot process this follow-up because Linear did not identify its author.",
    });
    return "handled";
  }

  const existingTarget = await resolveStoredSessionTarget(env, existingSession, traceId);
  const currentIntegration = existingTarget
    ? await resolveTargetIntegration(env, existingTarget)
    : null;
  const callbackContext = buildLinearCallbackContext({
    webhook,
    issue,
    model: existingSession.model,
    repoFullName: currentIntegration?.callbackRepoFullName,
    emitToolProgressActivities: currentIntegration?.config.emitToolProgressActivities,
  });

  // Linear's activities are the reliable record of what was said so far. Only
  // fall back to the control plane's last token event when they hold no agent turn.
  const conversationHistory = selectConversationHistory(
    await fetchAgentSessionActivities(client, agentSessionId),
    { excludeLatestPromptBody: followUp.content }
  );

  await assertNotStopped(env, agentSessionId, "before_events_fetch");
  let sessionContextSummary = "";
  if (historyHasAgentTurn(conversationHistory)) {
    /* history already carries the previous agent response */
  } else
    try {
      const eventsUrl = `https://internal/sessions/${existingSession.sessionId}/events?type=token&limit=20`;
      const eventsRes = await signedControlPlaneFetch(env, {
        method: "GET",
        url: eventsUrl,
        actor: `linear:${followUp.actorUserId}`,
        traceId,
      });
      if (eventsRes.ok) {
        const eventsData = sessionEventsSummaryResponseSchema.safeParse(await eventsRes.json());
        const latestContent = eventsData.success
          ? eventsData.data.events[0]?.data.content
          : undefined;
        if (latestContent) {
          sessionContextSummary = latestContent.slice(0, 500);
        }
      }
    } catch {
      /* best effort */
    }

  await assertNotStopped(env, agentSessionId, "before_prompt");
  const promptUrl = `https://internal/sessions/${existingSession.sessionId}/prompt`;
  const promptBody = JSON.stringify({
    content: buildFollowUpPrompt({
      issueIdentifier: issue.identifier,
      followUpContent: followUp.content,
      followUpSource: followUp.source,
      followUpAuthor: "linear",
      sessionContextSummary,
      conversationHistory,
    }),
    source: "linear",
    callbackContext,
  });
  const promptRes = await signedControlPlaneFetch(env, {
    method: "POST",
    url: promptUrl,
    body: promptBody,
    actor: `linear:${followUp.actorUserId}`,
    traceId,
  });

  if (promptRes.status === 409) {
    // The control plane refuses prompts on cancelled/archived sessions. Drop
    // the mapping so this request starts a fresh session instead.
    log.info("agent_session.followup_session_gone", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      session_id: existingSession.sessionId,
      agent_session_id: agentSessionId,
      http_status: promptRes.status,
    });
    await deleteIssueSession(env, issue.id);
    return "session_gone";
  }

  if (promptRes.ok) {
    const parsed = sendPromptResponseSchema.safeParse(await readJsonSafe(promptRes));
    const queued = parsed.success && parsed.data.status === "queued";
    await emitAgentActivity(client, agentSessionId, {
      type: "thought",
      body: queued
        ? `Follow-up queued — the agent is finishing its current step and will pick this up next.\n\n${sessionLink(env, existingSession.sessionId)}`
        : `Follow-up sent to existing session.\n\n${sessionLink(env, existingSession.sessionId)}`,
    });
    await touchKeepalive(env, agentSessionId);
  } else {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Failed to send follow-up to the existing session.",
    });
  }

  log.info("agent_session.followup", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    session_id: existingSession.sessionId,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
  return "handled";
}

/**
 * Stop and forget a control-plane session that was created moments before a
 * stop request arrived, so the sandbox does not run work nobody wants.
 */
async function abortCreatedSession(params: {
  env: Env;
  traceId: string;
  agentSessionId: string;
  issue: AgentSessionWebhookIssue;
  sessionId: string;
  fallbackActorUserId: string | undefined;
}): Promise<void> {
  const { env, traceId, agentSessionId, issue, sessionId, fallbackActorUserId } = params;
  const marker = await readStopMarker(env, agentSessionId);
  const actorUserId = marker?.actorUserId ?? fallbackActorUserId;
  await deleteIssueSession(env, issue.id);
  if (!actorUserId) {
    log.warn("agent_session.aborted_after_create", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      session_id: sessionId,
      outcome: "no_actor",
    });
    return;
  }
  try {
    const stopRes = await signedControlPlaneFetch(env, {
      method: "POST",
      url: `https://internal/sessions/${sessionId}/stop`,
      actor: `linear:${actorUserId}`,
      traceId,
    });
    log.info("agent_session.aborted_after_create", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      session_id: sessionId,
      outcome: stopSucceeded(stopRes.status) ? "stopped" : "stop_failed",
      stop_status: stopRes.status,
    });
  } catch (e) {
    log.error("agent_session.aborted_after_create", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      session_id: sessionId,
      outcome: "stop_failed",
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

async function handleNewSession(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string,
  tracker: PlanTracker
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const {
    resolutionComment,
    instructionComment,
    clarificationReply,
    actorUserId: sessionActorUserId,
  } = getNewSessionInput(webhook);
  const orgId = webhook.organizationId;
  // Automation-created sessions carry no human actor; act as the installed app
  // user so the control plane still receives an actor for create/prompt.
  const launchActorUserId =
    sessionActorUserId ?? (webhook.action === "created" ? webhook.appUserId : undefined);

  const client = await getAgentSessionLinearClient({
    env,
    traceId,
    orgId,
    agentSessionId,
    issue,
    mode: "start",
    expectedAppUserId: webhook.appUserId,
  });
  if (!client) return;

  // Ack first: Linear expects the first activity within 10 s of the event.
  await emitAgentActivity(
    client,
    agentSessionId,
    { type: "thought", body: "Analyzing issue and resolving repository..." },
    { ephemeral: true }
  );
  await assertNotStopped(env, agentSessionId, "after_ack");
  await setPlan(client, agentSessionId, tracker, "start");

  // Fetch full issue details for context
  await assertNotStopped(env, agentSessionId, "before_fetch_issue");
  const issueDetails = await fetchIssueDetails(client, issue.id);
  // A `prompted` event without a session mapping continues an existing agent
  // session (expired mapping, or a re-prompt after a stop): replay its history
  // so the fresh sandbox knows what was asked and answered before.
  const conversationHistory =
    webhook.action === "prompted"
      ? selectConversationHistory(await fetchAgentSessionActivities(client, agentSessionId), {
          excludeLatestPromptBody: clarificationReply?.body,
        })
      : [];
  const labels = issueDetails?.labels || issue.labels || [];
  const labelNames = labels.map((l) => l.name);
  const projectInfo = issueDetails?.project || issue.project;

  // ─── Resolve target ───────────────────────────────────────────────────

  await assertNotStopped(env, agentSessionId, "before_resolve_target");
  const resolved = await resolveSessionTarget({
    env,
    client,
    agentSessionId,
    issue,
    labelNames,
    projectInfo,
    comment: resolutionComment,
    traceId,
  });
  if (!resolved) return;

  const { target, reasoning: classificationReasoning } = resolved;
  const label = targetLabel(target);

  await assertNotStopped(env, agentSessionId, "before_integration_lookup");
  const integration = await resolveTargetIntegration(env, target);
  const integrationConfig = integration.config;
  if (!integration.enabled) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for ${integration.notEnabledSubject}.`,
    });
    await updateAgentSession(client, agentSessionId, { plan: cancelPlanFrom(tracker.stage) });
    log.info("agent_session.repo_not_enabled", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      target: targetId(target),
      repo: integration.settingsRepo,
    });
    return;
  }

  // ─── Resolve user preferences and identity ────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  let actorDisplayName: string | undefined;
  let actorEmail: string | undefined;
  if (sessionActorUserId) {
    const prefs = await getUserPreferences(env, sessionActorUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;

    const linearUser = await fetchUser(client, sessionActorUserId);
    actorDisplayName = linearUser?.name;
    actorEmail = linearUser?.email ?? undefined;
  }

  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    userModel,
    userReasoningEffort,
    labelModel,
  });

  // ─── Create session ───────────────────────────────────────────────────

  await setPlan(client, agentSessionId, tracker, "repo_resolved");
  await emitAgentActivity(
    client,
    agentSessionId,
    { type: "thought", body: `Creating coding session on ${label} (model: ${model})...` },
    { ephemeral: true }
  );

  await assertNotStopped(env, agentSessionId, "before_create_session");
  const sessionResult = await createSession(
    env,
    target,
    {
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
      actorUserId: launchActorUserId,
      actorDisplayName,
      actorEmail,
    },
    traceId
  );

  if (!sessionResult.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to create a coding session.\n\n\`HTTP ${sessionResult.status}: ${sessionResult.body.slice(0, 200)}\``,
    });
    await updateAgentSession(client, agentSessionId, { plan: cancelPlanFrom(tracker.stage) });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      target: targetId(target),
      http_status: sessionResult.status,
      response_body: sessionResult.body.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const session = sessionResult;

  // From here on a control-plane session exists; a stop request must also
  // stop it, not just abandon this flow.
  try {
    await assertNotStopped(env, agentSessionId, "after_create_session");

    const callbackContext = buildLinearCallbackContext({
      webhook,
      issue,
      model,
      repoFullName: integration.callbackRepoFullName,
      emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
      transitionIssueOnStart: shouldTransitionIssueOnStart(webhook),
    });

    await storeIssueSession(env, issue.id, {
      sessionId: session.sessionId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...targetRequestFields(target),
      model,
      agentSessionId,
      organizationId: orgId,
      createdAt: Date.now(),
    });

    // Set externalUrls and update plan
    await updateAgentSession(client, agentSessionId, {
      externalUrls: [
        { label: "View Session", url: `${env.WEB_APP_URL}/session/${session.sessionId}` },
      ],
      plan: makePlan("session_created"),
    });
    tracker.stage = "session_created";
    tracker.planSet = true;

    // Best practice: when a person delegates implementation work and nobody is
    // the delegate yet, the agent makes itself the delegate. Automations keep
    // the issue as they left it, and a deployment can opt out.
    if (
      webhook.action === "created" &&
      Boolean(webhook.agentSession.creatorId?.trim()) &&
      issueDetails &&
      integrationConfig.setIssueDelegateOnStart !== false
    ) {
      const delegateResult = await ensureSelfDelegate(client, {
        issueId: issue.id,
        appUserId: webhook.appUserId,
        currentDelegateId: issueDetails.delegate?.id ?? null,
      });
      log.info("agent_session.delegate", {
        trace_id: traceId,
        issue_identifier: issue.identifier,
        agent_session_id: agentSessionId,
        ...delegateResult,
      });
    }

    // ─── Build and send prompt ────────────────────────────────────────────

    // Prefer Linear's promptContext (includes issue, comments, guidance)
    let prompt = webhook.promptContext
      ? buildPromptContextPrompt(webhook.promptContext, conversationHistory)
      : buildPrompt(
          issue,
          issueDetails,
          instructionComment,
          clarificationReply,
          conversationHistory
        );

    if (integrationConfig.issueSessionInstructions) {
      prompt += `\n\n## Additional Instructions\n\n${integrationConfig.issueSessionInstructions}`;
    }

    await assertNotStopped(env, agentSessionId, "before_prompt");
    const promptUrl = `https://internal/sessions/${session.sessionId}/prompt`;
    const promptBody = JSON.stringify({
      content: prompt,
      source: "linear",
      callbackContext,
    });
    const promptRes = await signedControlPlaneFetch(env, {
      method: "POST",
      url: promptUrl,
      body: promptBody,
      actor: launchActorUserId ? `linear:${launchActorUserId}` : undefined,
      traceId,
    });

    if (!promptRes.ok) {
      let promptErrBody = "";
      try {
        promptErrBody = await promptRes.text();
      } catch {
        /* ignore */
      }
      await emitAgentActivity(client, agentSessionId, {
        type: "error",
        body: `Failed to send the prompt to the coding session.\n\n\`HTTP ${promptRes.status}: ${promptErrBody.slice(0, 200)}\``,
      });
      await updateAgentSession(client, agentSessionId, { plan: cancelPlanFrom(tracker.stage) });
      log.error("control_plane.send_prompt", {
        trace_id: traceId,
        session_id: session.sessionId,
        issue_identifier: issue.identifier,
        http_status: promptRes.status,
        response_body: promptErrBody.slice(0, 500),
        duration_ms: Date.now() - startTime,
      });
      return;
    }

    await assertNotStopped(env, agentSessionId, "before_final_thought");
    await emitAgentActivity(client, agentSessionId, {
      type: "thought",
      body: `Working on \`${label}\` with **${model}**.\n\n${classificationReasoning ? `*${classificationReasoning}*\n\n` : ""}${sessionLink(env, session.sessionId)}`,
    });
    await touchKeepalive(env, agentSessionId);
  } catch (err) {
    if (err instanceof StopRequestedError) {
      await abortCreatedSession({
        env,
        traceId,
        agentSessionId,
        issue,
        sessionId: session.sessionId,
        fallbackActorUserId: launchActorUserId,
      });
    }
    throw err;
  }

  log.info("agent_session.session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    target: targetId(target),
    model,
    classification_reasoning: classificationReasoning,
    duration_ms: Date.now() - startTime,
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

function nonIssueSessionMessage(env: Env): string {
  return `${resolveAppName(env)} can only work on Linear issues. Mention or delegate it from an issue to start a coding session.`;
}

/**
 * Last-resort reporter for a flow that threw: Linear would otherwise keep
 * showing the session as working forever.
 */
async function reportUnhandledFailure(
  webhook: AgentSessionWebhook,
  env: Env,
  traceId: string,
  tracker: PlanTracker
): Promise<void> {
  const agentSessionId = webhook.agentSession.id;
  try {
    const client = await getLinearClient(env, webhook.organizationId, webhook.appUserId);
    if (!client) return;
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `${resolveAppName(env)} hit an unexpected error and could not continue. Reference: \`${traceId}\``,
    });
    if (tracker.planSet) {
      await updateAgentSession(client, agentSessionId, { plan: cancelPlanFrom(tracker.stage) });
    }
  } catch (err) {
    log.error("agent_session.report_failure_failed", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

export async function handleAgentSessionEvent(
  webhook: AgentSessionWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const tracker = createPlanTracker();
  try {
    await dispatchAgentSessionEvent(webhook, env, traceId, tracker);
  } catch (err) {
    if (err instanceof StopRequestedError) {
      log.info("agent_session.aborted_by_stop", {
        trace_id: traceId,
        agent_session_id: err.agentSessionId,
        checkpoint: err.checkpoint,
      });
      return;
    }
    log.error("agent_session.unhandled_error", {
      trace_id: traceId,
      agent_session_id: webhook.agentSession.id,
      action: webhook.action,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    await reportUnhandledFailure(webhook, env, traceId, tracker);
  }
}

async function dispatchAgentSessionEvent(
  webhook: AgentSessionWebhook,
  env: Env,
  traceId: string,
  tracker: PlanTracker
): Promise<void> {
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;

  log.info("agent_session.received", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    issue_id: issue?.id,
    issue_identifier: issue?.identifier,
    has_comment: Boolean(webhook.agentSession.comment),
    org_id: webhook.organizationId,
  });

  // Stop handling
  if (webhook.agentActivity?.signal === "stop") {
    return handleStop(webhook, env, traceId);
  }

  // Any other event is a fresh instruction for this agent session and
  // supersedes an earlier stop request.
  await clearStopMarker(env, agentSessionId);

  if (!issue) {
    log.warn("agent_session.no_issue", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      agent_session_keys: Object.keys(webhook.agentSession),
    });
    const client = await getLinearClient(env, webhook.organizationId, webhook.appUserId);
    if (client) {
      await emitAgentActivity(client, agentSessionId, {
        type: "error",
        body: nonIssueSessionMessage(env),
      });
    }
    return;
  }

  // Follow-up handling (action: "prompted" with existing session)
  const existingSession = await lookupIssueSession(env, issue.id);
  if (existingSession && webhook.action === "prompted") {
    const outcome = await handleFollowUp(webhook, issue, env, traceId, existingSession);
    if (outcome === "handled") return;
  }

  // New session
  return handleNewSession(webhook, issue, env, traceId, tracker);
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export function buildPrompt(
  issue: { identifier: string; title: string; description?: string | null; url: string },
  issueDetails: LinearIssueDetails | null,
  comment?: { body: string } | null,
  clarificationReply?: { body: string } | null,
  conversationHistory?: ConversationTurn[]
): string {
  const parts: string[] = [
    `Linear Issue: ${issue.identifier}`,
    `URL: ${issue.url}`,
    "",
    "## Issue Title",
    buildUntrustedUserContentBlock({
      source: "linear_issue_title",
      author: "unknown",
      content: issue.title,
    }),
    "",
    "## Description",
  ];

  if (issue.description) {
    parts.push(
      buildUntrustedUserContentBlock({
        source: "linear_issue_description",
        author: "unknown",
        content: issue.description,
      })
    );
  } else {
    parts.push("(No description provided)");
  }

  // Add context from full issue details
  if (issueDetails) {
    if (issueDetails.labels.length > 0) {
      parts.push("", `**Labels:** ${issueDetails.labels.map((l) => l.name).join(", ")}`);
    }
    if (issueDetails.project) {
      parts.push(`**Project:** ${issueDetails.project.name}`);
    }
    if (issueDetails.assignee) {
      parts.push(`**Assignee:** ${issueDetails.assignee.name}`);
    }
    if (issueDetails.priorityLabel) {
      parts.push(`**Priority:** ${issueDetails.priorityLabel}`);
    }

    // Include recent comments for context
    if (issueDetails.comments.length > 0) {
      parts.push("", "---", "**Recent comments:**");
      for (const c of issueDetails.comments.slice(-5)) {
        const author = c.user?.name || "Unknown";
        parts.push(
          buildUntrustedUserContentBlock({
            source: "linear_issue_comment",
            author,
            content: c.body.slice(0, 200),
          })
        );
      }
    }
  }

  if (comment?.body) {
    parts.push(
      "",
      "---",
      "**Agent instruction:**",
      buildUntrustedUserContentBlock({
        source: "linear_agent_instruction",
        author: "unknown",
        content: comment.body,
      })
    );
  }

  if (clarificationReply?.body) {
    parts.push(
      "",
      "---",
      "**Repository clarification:**",
      buildUntrustedUserContentBlock({
        source: "linear_repository_clarification",
        author: "unknown",
        content: clarificationReply.body,
      })
    );
  }

  parts.push(...renderConversationHistory(conversationHistory));

  parts.push(
    "",
    "Please implement the changes described in this issue. Create a pull request when done."
  );

  return parts.join("\n");
}
