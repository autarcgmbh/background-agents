/**
 * Stop markers — KV flags that let a Linear `stop` signal abort an in-flight
 * agent-session flow (repo resolution, session creation, prompt delivery)
 * that is running in another Worker invocation.
 *
 * The stop handler writes the marker first, then stops the control-plane
 * session. Every expensive step of the new-session and follow-up flows calls
 * {@link assertNotStopped} so the flow bails out within one KV read of the
 * stop request. The aborted flow emits nothing; the stop handler owns the
 * user-visible confirmation activity.
 */

import { z } from "zod";
import type { Env } from "./types";

/** Longer than any single agent-session flow (classifier + session create + prompt). */
export const STOP_MARKER_TTL_SECONDS = 600;

const stopMarkerSchema = z.object({
  state: z.enum(["requested", "confirmed"]),
  requestedAt: z.number(),
  actorUserId: z.string().optional(),
  source: z.enum(["agent_activity", "unassigned"]),
});

export type StopMarker = z.infer<typeof stopMarkerSchema>;

export class StopRequestedError extends Error {
  constructor(
    readonly agentSessionId: string,
    readonly checkpoint: string
  ) {
    super(`Stop requested for agent session ${agentSessionId} at ${checkpoint}`);
    this.name = "StopRequestedError";
  }
}

function stopMarkerKey(agentSessionId: string): string {
  return `stop:${agentSessionId}`;
}

export async function markStopRequested(
  env: Env,
  agentSessionId: string,
  meta: { actorUserId?: string; source: StopMarker["source"] }
): Promise<void> {
  const marker: StopMarker = {
    state: "requested",
    requestedAt: Date.now(),
    actorUserId: meta.actorUserId,
    source: meta.source,
  };
  await env.LINEAR_KV.put(stopMarkerKey(agentSessionId), JSON.stringify(marker), {
    expirationTtl: STOP_MARKER_TTL_SECONDS,
  });
}

export async function markStopConfirmed(env: Env, agentSessionId: string): Promise<void> {
  const existing = await readStopMarker(env, agentSessionId);
  const marker: StopMarker = {
    state: "confirmed",
    requestedAt: existing?.requestedAt ?? Date.now(),
    actorUserId: existing?.actorUserId,
    source: existing?.source ?? "agent_activity",
  };
  await env.LINEAR_KV.put(stopMarkerKey(agentSessionId), JSON.stringify(marker), {
    expirationTtl: STOP_MARKER_TTL_SECONDS,
  });
}

/**
 * Read the stop marker. A present-but-malformed value is reported as a
 * `requested` marker: when in doubt, stop.
 */
export async function readStopMarker(env: Env, agentSessionId: string): Promise<StopMarker | null> {
  const raw = await env.LINEAR_KV.get(stopMarkerKey(agentSessionId));
  if (raw === null) return null;
  try {
    const parsed = stopMarkerSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through to the fail-safe marker */
  }
  return { state: "requested", requestedAt: 0, source: "agent_activity" };
}

export function clearStopMarker(env: Env, agentSessionId: string): Promise<void> {
  return env.LINEAR_KV.delete(stopMarkerKey(agentSessionId));
}

/** Throw {@link StopRequestedError} when a stop marker exists for the session. */
export async function assertNotStopped(
  env: Env,
  agentSessionId: string,
  checkpoint: string
): Promise<void> {
  const marker = await readStopMarker(env, agentSessionId);
  if (marker) throw new StopRequestedError(agentSessionId, checkpoint);
}
