/**
 * Handlers for the non-session webhook categories a Linear agent should
 * subscribe to: inbox notifications (`AppUserNotification`), team access
 * changes (`PermissionChange`) and app revocation (`OAuthApp`).
 */

import type {
  AppUserNotificationWebhook,
  Env,
  OAuthAppWebhook,
  PermissionChangeWebhook,
} from "./types";
import { createLogger } from "./logger";
import { deleteIssueSession, lookupIssueSession } from "./kv-store";
import { markStopConfirmed, markStopRequested } from "./stop-marker";
import { emitAgentActivity, getLinearClient, updateAgentSession } from "./utils/linear-client";
import {
  deleteClientCredentialCache,
  deleteLegacyOAuthToken,
} from "./utils/linear-credential-cache";
import { cancelPlanFrom } from "./plan";
import { stopMappedSession } from "./webhook-handler";
import { resolveAppName } from "@open-inspect/shared/app-name";

const log = createLogger("notifications");

/** Upper bound on issue mappings inspected when purging a revoked workspace. */
const REVOCATION_PURGE_LIST_LIMIT = 1000;

export async function handleAppUserNotification(
  webhook: AppUserNotificationWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const notification = webhook.notification;
  const issueId = notification.issueId ?? notification.issue?.id;
  const actorUserId = notification.actorId ?? notification.actor?.id ?? undefined;

  log.info("notification.received", {
    trace_id: traceId,
    action: webhook.action,
    org_id: webhook.organizationId,
    issue_id: issueId,
    actor_id: actorUserId,
    has_comment: Boolean(notification.commentId),
    notification_keys: Object.keys(notification),
  });

  // Mentions and assignment already create agent sessions; reactions,
  // comments and status changes are informational for now.
  if (webhook.action !== "issueUnassignedFromYou") return;

  if (!issueId) {
    log.warn("notification.unassigned", {
      trace_id: traceId,
      outcome: "skipped",
      skip_reason: "no_issue",
    });
    return;
  }

  const mapping = await lookupIssueSession(env, issueId);
  if (!mapping) {
    log.info("notification.unassigned", {
      trace_id: traceId,
      issue_id: issueId,
      outcome: "skipped",
      skip_reason: "no_session",
    });
    return;
  }

  // Unassignment is a request to disengage: stop the sandbox, and abort any
  // in-flight start for the same agent session.
  if (mapping.agentSessionId) {
    await markStopRequested(env, mapping.agentSessionId, { actorUserId, source: "unassigned" });
  }
  const client = mapping.agentSessionId
    ? await getLinearClient(env, webhook.organizationId, webhook.appUserId)
    : null;

  const result = await stopMappedSession({ env, traceId, mapping, actorUserId });
  if (!result.ok) {
    log.warn("notification.unassigned", {
      trace_id: traceId,
      issue_id: issueId,
      session_id: mapping.sessionId,
      outcome: "stop_failed",
      stop_status: result.status,
    });
    if (client && mapping.agentSessionId) {
      await emitAgentActivity(client, mapping.agentSessionId, {
        type: "error",
        body: `The issue was unassigned from ${resolveAppName(env)}, but stopping the coding session failed${result.status ? ` (HTTP ${result.status})` : ""}. It may still be running.`,
      });
    }
    return;
  }

  if (client && mapping.agentSessionId) {
    await emitAgentActivity(client, mapping.agentSessionId, {
      type: "response",
      body: `The issue was unassigned from ${resolveAppName(env)}, so the coding session was stopped.`,
    });
    await updateAgentSession(client, mapping.agentSessionId, {
      plan: cancelPlanFrom("session_created"),
    });
    await markStopConfirmed(env, mapping.agentSessionId);
  }

  log.info("notification.unassigned", {
    trace_id: traceId,
    issue_id: issueId,
    session_id: mapping.sessionId,
    agent_session_id: mapping.agentSessionId,
    outcome: "stopped",
  });
}

export async function handlePermissionChange(
  webhook: PermissionChangeWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  void env;
  log.info("permission.team_access_changed", {
    trace_id: traceId,
    org_id: webhook.organizationId,
    app_user_id: webhook.appUserId,
    can_access_all_public_teams: webhook.canAccessAllPublicTeams,
    added_count: webhook.addedTeamIds.length,
    removed_count: webhook.removedTeamIds.length,
    added_team_ids: webhook.addedTeamIds,
    removed_team_ids: webhook.removedTeamIds,
  });
}

/**
 * The workspace revoked the app: drop its runtime credentials and the
 * issue→session mappings that could no longer be acted on anyway.
 */
export async function handleOAuthAppRevoked(
  webhook: OAuthAppWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const orgId = webhook.organizationId;
  await deleteClientCredentialCache(env, orgId);
  await deleteLegacyOAuthToken(env, orgId);

  let purged = 0;
  let inspected = 0;
  try {
    const listed = await env.LINEAR_KV.list({
      prefix: "issue:",
      limit: REVOCATION_PURGE_LIST_LIMIT,
    });
    for (const key of listed.keys) {
      inspected += 1;
      const raw = await env.LINEAR_KV.get(key.name, "json");
      if (
        raw &&
        typeof raw === "object" &&
        (raw as { organizationId?: unknown }).organizationId === orgId
      ) {
        await deleteIssueSession(env, key.name.slice("issue:".length));
        purged += 1;
      }
    }
  } catch (err) {
    log.warn("oauth.revoked_purge_failed", {
      trace_id: traceId,
      org_id: orgId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  log.info("oauth.revoked", {
    trace_id: traceId,
    org_id: orgId,
    inspected_mappings: inspected,
    purged_mappings: purged,
  });
}
