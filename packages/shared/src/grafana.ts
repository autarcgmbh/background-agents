/**
 * Grafana Agent Observability deep links.
 *
 * Sessions export their conversations to Grafana under the agent's own
 * conversation id (see docs/AGENT_OBSERVABILITY.md), so anything holding that
 * id can link straight at the conversation. Shared because the web sidebar and
 * the Linear bot both surface the link and must not drift on its shape.
 *
 * Each caller supplies the stack origin from its own configuration: the web
 * app from the build-time `NEXT_PUBLIC_GRAFANA_URL`, the bots from a worker
 * binding. Deployments that export nothing to Grafana leave it unset.
 */

/** The Agent Observability app's conversation route on a Grafana stack. */
export const GRAFANA_CONVERSATION_PATH = "/a/grafana-agento11y-app/conversations";

/**
 * The stack origin, with any path supplied alongside it dropped — the setup
 * page's own URL is the most likely thing to be copied out of an address bar,
 * and it is not the origin the links hang off. Null when unusable, so a
 * misconfigured value omits the link instead of producing a broken one.
 */
export function resolveGrafanaStackOrigin(stackUrl: string | null | undefined): string | null {
  const raw = stackUrl?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * The Grafana conversation URL for an agent conversation id, or null when
 * there is no configured stack or the session has no conversation yet —
 * nothing has been exported for it either, so there is nothing to open.
 */
export function buildGrafanaConversationUrl(
  stackUrl: string | null | undefined,
  agentSessionId: string | null | undefined
): string | null {
  const origin = resolveGrafanaStackOrigin(stackUrl);
  if (!origin || !agentSessionId) return null;
  return `${origin}${GRAFANA_CONVERSATION_PATH}/${encodeURIComponent(agentSessionId)}`;
}
