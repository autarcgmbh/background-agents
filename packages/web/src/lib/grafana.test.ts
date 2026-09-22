import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { getGrafanaConversationUrl, isGrafanaLinkConfigured } from "./grafana";

// The link's shape is covered in @open-inspect/shared; these cases cover the
// build-time env var this module reads it from.
const originalStackUrl = process.env.NEXT_PUBLIC_GRAFANA_URL;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_GRAFANA_URL;
});

afterEach(() => {
  if (originalStackUrl === undefined) {
    delete process.env.NEXT_PUBLIC_GRAFANA_URL;
  } else {
    process.env.NEXT_PUBLIC_GRAFANA_URL = originalStackUrl;
  }
});

describe("getGrafanaConversationUrl", () => {
  it("links the conversation on the configured stack", () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL = "https://autarc.grafana.net";

    expect(getGrafanaConversationUrl("ses_abc123")).toBe(
      "https://autarc.grafana.net/a/grafana-agento11y-app/conversations/ses_abc123"
    );
    expect(isGrafanaLinkConfigured()).toBe(true);
  });

  it("returns null when the deployment has no Grafana stack", () => {
    expect(getGrafanaConversationUrl("ses_abc123")).toBeNull();
    expect(isGrafanaLinkConfigured()).toBe(false);
  });

  it("returns null while the session has no agent conversation yet", () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL = "https://autarc.grafana.net";

    expect(getGrafanaConversationUrl(null)).toBeNull();
    expect(getGrafanaConversationUrl(undefined)).toBeNull();
  });
});
