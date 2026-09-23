import { describe, expect, it } from "vitest";
import { buildGrafanaConversationUrl, resolveGrafanaStackOrigin } from "./grafana";

const STACK = "https://autarc.grafana.net";

describe("buildGrafanaConversationUrl", () => {
  it("builds the conversation deep link from the stack origin", () => {
    expect(buildGrafanaConversationUrl(STACK, "ses_f36c08835ffelNQlZSu9HhnpF2")).toBe(
      "https://autarc.grafana.net/a/grafana-agento11y-app/conversations/ses_f36c08835ffelNQlZSu9HhnpF2"
    );
  });

  it("drops a path pasted along with the stack URL", () => {
    // The setup-coding-agent page is the likeliest thing copied from the bar.
    expect(
      buildGrafanaConversationUrl(
        `${STACK}/a/grafana-agento11y-app/setup-coding-agent`,
        "ses_abc123"
      )
    ).toBe("https://autarc.grafana.net/a/grafana-agento11y-app/conversations/ses_abc123");
  });

  it("tolerates a trailing slash and surrounding whitespace", () => {
    expect(buildGrafanaConversationUrl("  https://autarc.grafana.net/  ", "ses_abc123")).toBe(
      "https://autarc.grafana.net/a/grafana-agento11y-app/conversations/ses_abc123"
    );
  });

  it("encodes the conversation id as one path segment", () => {
    expect(buildGrafanaConversationUrl(STACK, "a/b?c")).toBe(
      "https://autarc.grafana.net/a/grafana-agento11y-app/conversations/a%2Fb%3Fc"
    );
  });

  it("keeps a self-hosted Grafana on its own scheme, host and port", () => {
    expect(buildGrafanaConversationUrl("http://localhost:3000/", "ses_abc123")).toBe(
      "http://localhost:3000/a/grafana-agento11y-app/conversations/ses_abc123"
    );
  });

  it.each([undefined, null, "", "   ", "not a url", "ftp://autarc.grafana.net"])(
    "returns null for an unusable stack URL (%s)",
    (stackUrl) => {
      expect(buildGrafanaConversationUrl(stackUrl, "ses_abc123")).toBeNull();
      expect(resolveGrafanaStackOrigin(stackUrl)).toBeNull();
    }
  );

  it.each([undefined, null, ""])(
    "returns null while the session has no agent conversation yet (%s)",
    (agentSessionId) => {
      expect(buildGrafanaConversationUrl(STACK, agentSessionId)).toBeNull();
      // The stack itself is still usable — only this session has nothing yet.
      expect(resolveGrafanaStackOrigin(STACK)).toBe(STACK);
    }
  );
});
