import { Hono } from "hono";
import {
  linearProgressCallbackSchema,
  type LinearProgressCallback,
} from "@open-inspect/shared/types/session-api";
import { isSignedCallbackPayload } from "@open-inspect/shared/auth";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { rejectInvalidCallback } from "./reject-invalid-callback";
import { isStaleCallback } from "./constants";
import { emitAgentActivity, getLinearClient } from "../utils/linear-client";
import { claimKeepaliveSlot, isMessageCompleted, touchKeepalive } from "../kv-store";

const log = createLogger("callback");

/** How long the hash of the last surfaced text segment is remembered per agent session. */
const PROGRESS_TEXT_DEDUPE_TTL_SECONDS = 600;

interface ProgressCallbackDependencies {
  getLinearClient: typeof getLinearClient;
  emitAgentActivity: typeof emitAgentActivity;
  now: () => number;
}

const defaultDependencies: ProgressCallbackDependencies = {
  getLinearClient,
  emitAgentActivity,
  now: () => Date.now(),
};

function formatElapsed(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / 60_000);
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

/** The ephemeral keepalive thought shown while a run is silent. Exported for tests. */
export function formatHeartbeatThought(payload: LinearProgressCallback): string {
  const parts: string[] = [];
  if (payload.toolCallCount !== undefined) {
    parts.push(
      `${payload.toolCallCount} tool call${payload.toolCallCount === 1 ? "" : "s"} so far`
    );
  }
  parts.push(formatElapsed(payload.elapsedMs));
  let status = `Still working — ${parts.join(", ")}`;
  if (payload.currentTool) {
    status += `, currently running \`${payload.currentTool.tool}\``;
  }
  status += ".";
  return payload.latestText ? `${payload.latestText}\n\n_${status}_` : status;
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createProgressCallbackRouter(
  dependencies: ProgressCallbackDependencies = defaultDependencies
): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/progress", async (c) => {
    const startTime = dependencies.now();
    const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
    let rawPayload: unknown;
    try {
      rawPayload = await c.req.json();
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }
    if (!isSignedCallbackPayload(rawPayload)) {
      return c.json({ error: "invalid payload" }, 400);
    }
    const parsed = linearProgressCallbackSchema.safeParse(rawPayload);
    if (!parsed.success) {
      log.warn("http.request", {
        trace_id: traceId,
        http_path: "/callbacks/progress",
        http_status: 400,
        outcome: "rejected",
        reject_reason: "invalid_payload",
      });
      return c.json({ error: "invalid payload" }, 400);
    }
    const payload = parsed.data;
    const logFields = {
      trace_id: traceId,
      session_id: payload.sessionId,
      message_id: payload.messageId,
      agent_session_id: payload.context.agentSessionId,
      trigger: payload.trigger,
    };

    // Verify the original object because the signature covers its JSON key order.
    const rejection = await rejectInvalidCallback(c, rawPayload, {
      path: "/callbacks/progress",
      traceId,
      startTime,
      sessionId: payload.sessionId,
    });
    if (rejection) return rejection;

    const finish = (outcome: string, extra: Record<string, unknown> = {}) => {
      log.info("callback.progress", {
        ...logFields,
        outcome,
        ...extra,
        duration_ms: dependencies.now() - startTime,
      });
      return c.json({ ok: true, outcome });
    };

    if (isStaleCallback(payload.timestamp, startTime)) return finish("stale_callback");

    const { context } = payload;
    if (!context.agentSessionId || !context.organizationId || !context.appUserId) {
      return finish("missing_agent_context");
    }
    const agentSessionId = context.agentSessionId;

    // A progress callback racing a completion must not resurrect the session.
    if (await isMessageCompleted(c.env, payload.sessionId, payload.messageId)) {
      return finish("message_completed");
    }

    if (payload.trigger === "heartbeat") {
      if (!(await claimKeepaliveSlot(c.env, agentSessionId))) return finish("throttled");
    } else {
      if (!payload.latestText?.trim()) return finish("no_text");
      const dedupeKey = `progress:text:${agentSessionId}`;
      const hash = await hashText(payload.latestText);
      if ((await c.env.LINEAR_KV.get(dedupeKey)) === hash) return finish("deduped");
      await c.env.LINEAR_KV.put(dedupeKey, hash, {
        expirationTtl: PROGRESS_TEXT_DEDUPE_TTL_SECONDS,
      });
    }

    const client = await dependencies.getLinearClient(
      c.env,
      context.organizationId,
      context.appUserId
    );
    if (!client) return finish("no_oauth_token");

    const delivered =
      payload.trigger === "heartbeat"
        ? await dependencies.emitAgentActivity(
            client,
            agentSessionId,
            { type: "thought", body: formatHeartbeatThought(payload) },
            { ephemeral: true }
          )
        : await dependencies.emitAgentActivity(client, agentSessionId, {
            type: "thought",
            body: payload.latestText ?? "",
          });
    if (delivered) await touchKeepalive(c.env, agentSessionId);
    return finish(delivered ? "emitted" : "emit_failed");
  });

  return router;
}
