/**
 * Grafana Agent Observability deep links.
 *
 * Sessions export their conversations to Grafana under the agent's own
 * conversation id (see docs/AGENT_OBSERVABILITY.md), so a session can link
 * straight at its conversation once the runtime has reported that id.
 *
 * The stack origin is read from NEXT_PUBLIC_GRAFANA_URL (a build-time env var,
 * inlined into the client bundle). Deployments that export nothing to Grafana
 * leave it unset and the link is simply absent.
 */

/** The Agent Observability app's conversation route on a Grafana stack. */
const CONVERSATION_PATH = "/a/grafana-agento11y-app/conversations";

/**
 * The stack origin, with any path the operator pasted along with it dropped —
 * the setup page's own URL is the most likely thing to be copied out of the
 * address bar, and it is not the origin the links hang off.
 */
function getStackOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_GRAFANA_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Whether this deployment has a Grafana stack to link into. */
export function isGrafanaLinkConfigured(): boolean {
  return getStackOrigin() !== null;
}

/**
 * The Grafana conversation URL for an agent conversation id, or null when the
 * deployment has no configured stack or the session has no conversation yet
 * (nothing has been exported for it either, so there is nothing to open).
 */
export function getGrafanaConversationUrl(
  agentSessionId: string | null | undefined
): string | null {
  const origin = getStackOrigin();
  if (!origin || !agentSessionId) return null;
  return `${origin}${CONVERSATION_PATH}/${encodeURIComponent(agentSessionId)}`;
}
