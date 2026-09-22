import { describe, expect, it, afterEach, beforeEach } from "vitest";

const originalStackUrl = process.env.NEXT_PUBLIC_GRAFANA_URL;

async function loadModule() {
  // The module reads the env var per call, but the import is cached across
  // tests — re-import so each case starts from the value it just set.
  return import("./grafana");
}

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
  it("builds the conversation deep link from the stack origin", async () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL = "https://mystack.grafana.net";
    const { getGrafanaConversationUrl } = await loadModule();

    expect(getGrafanaConversationUrl("conv-1")).toBe(
      "https://mystack.grafana.net/a/grafana-agento11y-app/conversations/conv-1"
    );
  });

  it("drops a path pasted along with the stack URL", async () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL =
      "https://mystack.grafana.net/a/grafana-agento11y-app/setup-coding-agent";
    const { getGrafanaConversationUrl } = await loadModule();

    expect(getGrafanaConversationUrl("conv-1")).toBe(
      "https://mystack.grafana.net/a/grafana-agento11y-app/conversations/conv-1"
    );
  });

  it("encodes the conversation id as one path segment", async () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL = "https://mystack.grafana.net";
    const { getGrafanaConversationUrl } = await loadModule();

    expect(getGrafanaConversationUrl("a/b?c")).toBe(
      "https://mystack.grafana.net/a/grafana-agento11y-app/conversations/a%2Fb%3Fc"
    );
  });

  it("keeps a self-hosted Grafana on its own scheme, host and port", async () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL = "http://localhost:3000/";
    const { getGrafanaConversationUrl } = await loadModule();

    expect(getGrafanaConversationUrl("conv-1")).toBe(
      "http://localhost:3000/a/grafana-agento11y-app/conversations/conv-1"
    );
  });

  it("returns null when the deployment has no Grafana stack", async () => {
    const { getGrafanaConversationUrl, isGrafanaLinkConfigured } = await loadModule();

    expect(getGrafanaConversationUrl("conv-1")).toBeNull();
    expect(isGrafanaLinkConfigured()).toBe(false);
  });

  it.each(["   ", "not a url", "ftp://mystack.grafana.net"])(
    "returns null for an unusable stack URL (%s)",
    async (value) => {
      process.env.NEXT_PUBLIC_GRAFANA_URL = value;
      const { getGrafanaConversationUrl, isGrafanaLinkConfigured } = await loadModule();

      expect(getGrafanaConversationUrl("conv-1")).toBeNull();
      expect(isGrafanaLinkConfigured()).toBe(false);
    }
  );

  it("returns null while the session has no agent conversation yet", async () => {
    process.env.NEXT_PUBLIC_GRAFANA_URL = "https://mystack.grafana.net";
    const { getGrafanaConversationUrl, isGrafanaLinkConfigured } = await loadModule();

    expect(getGrafanaConversationUrl(null)).toBeNull();
    expect(getGrafanaConversationUrl(undefined)).toBeNull();
    // The stack itself is still configured — only this session has nothing yet.
    expect(isGrafanaLinkConfigured()).toBe(true);
  });
});
