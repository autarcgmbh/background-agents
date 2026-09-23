/**
 * Grafana Agent Observability deep links for the web app.
 *
 * The link shape lives in `@open-inspect/shared/grafana` so the sidebar and
 * the Linear bot cannot drift; this module only supplies the stack origin,
 * read from NEXT_PUBLIC_GRAFANA_URL (a build-time env var, inlined into the
 * client bundle). Deployments that export nothing to Grafana leave it unset
 * and the link is simply absent.
 */

import {
  buildGrafanaConversationUrl,
  resolveGrafanaStackOrigin,
} from "@open-inspect/shared/grafana";

/** Whether this deployment has a Grafana stack to link into. */
export function isGrafanaLinkConfigured(): boolean {
  return resolveGrafanaStackOrigin(process.env.NEXT_PUBLIC_GRAFANA_URL) !== null;
}

/**
 * The Grafana conversation URL for an agent conversation id, or null when the
 * deployment has no configured stack or the session has no conversation yet.
 */
export function getGrafanaConversationUrl(
  agentSessionId: string | null | undefined
): string | null {
  return buildGrafanaConversationUrl(process.env.NEXT_PUBLIC_GRAFANA_URL, agentSessionId);
}
