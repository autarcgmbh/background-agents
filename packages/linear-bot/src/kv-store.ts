/**
 * KV accessor helpers for config, issue sessions, and event deduplication.
 *
 * The `config:*` and `user_prefs:*` keys are operator-managed: edit them
 * directly with `wrangler kv key put --namespace-id <LINEAR_KV> <key> <json>`
 * using these key formats:
 * - `config:team-repos`   — { [teamKey]: "owner/repo" }
 * - `config:project-repos` — { [projectId]: "owner/repo" }
 * - `user_prefs:<userId>`  — { userId, model, reasoningEffort?, updatedAt }
 */

import { z } from "zod";
import { issueSessionSchema, projectTargetSchema, teamTargetsSchema } from "./types";
import {
  userPreferencesSchema,
  type UserPreferences,
} from "@open-inspect/shared/types/session-api";
import type { Env, TeamRepoMapping, ProjectRepoMapping, IssueSession } from "./types";
import { createLogger } from "./logger";

const log = createLogger("kv-store");

const configRecordSchema = z.record(z.string(), z.unknown());

/**
 * Validate an operator-managed config record one key at a time.
 *
 * A malformed entry costs its own key and nothing else: rejecting the whole
 * record would drop every valid mapping too, and each dropped team or project
 * falls through to the classification heuristics, which can route its issues
 * at an unintended repository. Rejected keys are logged so the typo that
 * caused it is findable.
 */
function parseConfigEntries<T>(
  data: unknown,
  entrySchema: z.ZodType<T>,
  configKey: string
): Record<string, T> {
  const record = configRecordSchema.safeParse(data);
  if (!record.success) return {};

  const mapping: Record<string, T> = {};
  const rejectedKeys: string[] = [];
  for (const [key, value] of Object.entries(record.data)) {
    const entry = entrySchema.safeParse(value);
    if (entry.success) mapping[key] = entry.data;
    else rejectedKeys.push(key);
  }

  if (rejectedKeys.length > 0) {
    log.warn("kv.config_entries_rejected", { config_key: configKey, rejected_keys: rejectedKeys });
  }
  return mapping;
}

export async function getTeamRepoMapping(env: Env): Promise<TeamRepoMapping> {
  const configKey = "config:team-repos";
  try {
    const data = await env.LINEAR_KV.get(configKey, "json");
    return parseConfigEntries(data, teamTargetsSchema, configKey);
  } catch (e) {
    log.debug("kv.get_team_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getProjectRepoMapping(env: Env): Promise<ProjectRepoMapping> {
  const configKey = "config:project-repos";
  try {
    const data = await env.LINEAR_KV.get(configKey, "json");
    return parseConfigEntries(data, projectTargetSchema, configKey);
  } catch (e) {
    log.debug("kv.get_project_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  try {
    const data = await env.LINEAR_KV.get(`user_prefs:${userId}`, "json");
    const parsed = userPreferencesSchema.safeParse(data);
    if (parsed.success) return parsed.data;
  } catch (e) {
    log.debug("kv.get_user_preferences_failed", {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

function getIssueSessionKey(issueId: string): string {
  return `issue:${issueId}`;
}

export async function lookupIssueSession(env: Env, issueId: string): Promise<IssueSession | null> {
  try {
    const data = await env.LINEAR_KV.get(getIssueSessionKey(issueId), "json");
    const result = issueSessionSchema.safeParse(data);
    if (result.success) return result.data;
  } catch (e) {
    log.debug("kv.lookup_issue_session_failed", {
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export async function storeIssueSession(
  env: Env,
  issueId: string,
  session: IssueSession
): Promise<void> {
  await env.LINEAR_KV.put(getIssueSessionKey(issueId), JSON.stringify(session), {
    expirationTtl: 86400 * 7,
  });
}

export function deleteIssueSession(env: Env, issueId: string): Promise<void> {
  return env.LINEAR_KV.delete(getIssueSessionKey(issueId));
}

/**
 * Check if an event has already been processed (deduplication).
 */
export async function isDuplicateEvent(env: Env, eventKey: string): Promise<boolean> {
  const existing = await env.LINEAR_KV.get(`event:${eventKey}`);
  if (existing) return true;
  await env.LINEAR_KV.put(`event:${eventKey}`, "1", { expirationTtl: 3600 });
  return false;
}

// ─── Keepalive and completion markers ────────────────────────────────────────

/**
 * Minimum spacing between keepalive thoughts for one agent session. Linear
 * marks a session stale after 30 minutes of silence; five minutes leaves room
 * for several missed deliveries.
 */
export const KEEPALIVE_INTERVAL_SECONDS = 300;

/** How long a completed (sessionId, messageId) pair suppresses late progress callbacks. */
export const COMPLETED_MESSAGE_MARKER_TTL_SECONDS = 600;

function keepaliveKey(agentSessionId: string): string {
  return `keepalive:${agentSessionId}`;
}

/**
 * Claim the keepalive slot for an agent session. Returns false when a
 * keepalive (or any bot activity that called {@link touchKeepalive}) was
 * emitted within the interval. KV is eventually consistent, so two edge
 * workers may both claim a slot; the cost is one duplicate ephemeral thought.
 */
export async function claimKeepaliveSlot(env: Env, agentSessionId: string): Promise<boolean> {
  const existing = await env.LINEAR_KV.get(keepaliveKey(agentSessionId));
  if (existing) return false;
  await touchKeepalive(env, agentSessionId);
  return true;
}

/** Record that the bot just emitted an activity, postponing the next keepalive. */
export async function touchKeepalive(env: Env, agentSessionId: string): Promise<void> {
  await env.LINEAR_KV.put(keepaliveKey(agentSessionId), String(Date.now()), {
    expirationTtl: KEEPALIVE_INTERVAL_SECONDS,
  });
}

function completedMessageKey(sessionId: string, messageId: string): string {
  return `completed:${sessionId}:${messageId}`;
}

export async function markMessageCompleted(
  env: Env,
  sessionId: string,
  messageId: string
): Promise<void> {
  await env.LINEAR_KV.put(completedMessageKey(sessionId, messageId), "1", {
    expirationTtl: COMPLETED_MESSAGE_MARKER_TTL_SECONDS,
  });
}

export async function isMessageCompleted(
  env: Env,
  sessionId: string,
  messageId: string
): Promise<boolean> {
  return (await env.LINEAR_KV.get(completedMessageKey(sessionId, messageId))) !== null;
}
