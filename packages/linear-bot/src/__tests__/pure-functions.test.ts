import { describe, expect, it } from "vitest";
import { VALID_MODELS } from "@open-inspect/shared/models";
import {
  extractModelFromLabels,
  resolveSessionModelSettings,
  resolveStaticTarget,
} from "../model-resolution";
import { buildOAuthSuccessHtml } from "../index";
import { cancelPlanFrom, makePlan } from "../plan";
import {
  buildRepoSelectOptions,
  MAX_SELECT_OPTIONS,
  matchExplicitRepo,
  SUGGESTION_OPTION_MIN_CONFIDENCE,
} from "../target-resolution";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";

describe("buildOAuthSuccessHtml", () => {
  it("renders the configured app name in the heading", () => {
    const html = buildOAuthSuccessHtml("Acme Bot", "My Workspace");
    expect(html).toContain("<h1>Acme Bot Agent Installed!</h1>");
    expect(html).toContain("<strong>My Workspace</strong>");
  });

  it("escapes the app name to prevent HTML injection", () => {
    const html = buildOAuthSuccessHtml("<script>alert(1)</script>", "Acme");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the workspace name to prevent HTML injection", () => {
    const html = buildOAuthSuccessHtml("Open-Inspect", "Evil <img src=x>");
    expect(html).toContain("Evil &lt;img src=x&gt;");
  });
});

// ─── matchExplicitRepo ───────────────────────────────────────────────────────

describe("matchExplicitRepo", () => {
  const repo = (owner: string, name: string): RepoConfig => ({
    id: `${owner}/${name}`,
    owner,
    name,
    fullName: `${owner}/${name}`,
    displayName: name,
    description: name,
    defaultBranch: "main",
    private: true,
  });
  const repos = [repo("acme", "backend"), repo("acme", "frontend")];

  it("finds the one repository a clarification reply names", () => {
    expect(matchExplicitRepo("acme/backend", repos)?.fullName).toBe("acme/backend");
  });

  it("matches case-insensitively — repos are stored lowercase", () => {
    expect(matchExplicitRepo("use Acme/Backend please", repos)?.fullName).toBe("acme/backend");
  });

  it("returns null when several repositories are named", () => {
    expect(matchExplicitRepo("acme/backend or acme/frontend", repos)).toBeNull();
  });

  it("returns null when none are named", () => {
    expect(matchExplicitRepo("the vault sorting bug", repos)).toBeNull();
  });

  it("does not match inside a longer repository path", () => {
    expect(matchExplicitRepo("see acme/backend-legacy for context", repos)).toBeNull();
    expect(matchExplicitRepo("see notacme/backend for context", repos)).toBeNull();
  });

  it("does not match inside a period-delimited repository path", () => {
    expect(matchExplicitRepo("see acme/backend.docs for context", repos)).toBeNull();
    expect(matchExplicitRepo("see acme/backend..docs for context", repos)).toBeNull();
    expect(matchExplicitRepo("see not.acme/backend for context", repos)).toBeNull();
    expect(matchExplicitRepo("see not..acme/backend for context", repos)).toBeNull();
  });

  it("accepts ordinary terminal punctuation", () => {
    expect(matchExplicitRepo("use acme/backend.", repos)?.fullName).toBe("acme/backend");
    expect(matchExplicitRepo("use acme/backend...", repos)?.fullName).toBe("acme/backend");
    expect(matchExplicitRepo("acme/backend, please", repos)?.fullName).toBe("acme/backend");
  });
});

// ─── extractModelFromLabels ──────────────────────────────────────────────────

describe("extractModelFromLabels", () => {
  it.each([
    ["haiku", "anthropic/claude-haiku-4-5"],
    ["sonnet", "anthropic/claude-sonnet-4-5"],
    ["opus", "anthropic/claude-opus-4-5"],
    ["fable", "anthropic/claude-fable-5-1"],
  ])("returns the configured model for the model:%s alias", (alias, expected) => {
    expect(extractModelFromLabels([{ name: `model:${alias}` }])).toBe(expected);
  });

  it("returns model for case-insensitive label", () => {
    expect(extractModelFromLabels([{ name: "Model:Sonnet" }])).toBe("anthropic/claude-sonnet-4-5");
  });

  const versionedModelLabels = VALID_MODELS.flatMap((model) => {
    if (model.startsWith("anthropic/claude-")) {
      return [[model.replace("anthropic/claude-", ""), model] as const];
    }
    if (model.startsWith("openai/gpt-")) {
      return [[model.replace("openai/", ""), model] as const];
    }
    return [];
  });

  it.each(versionedModelLabels)("derives model:%s from the shared catalog", (label, expected) => {
    expect(extractModelFromLabels([{ name: `model:${label}` }])).toBe(expected);
  });

  it.each([
    ["claude-fable-5-1", "anthropic/claude-fable-5-1"],
    ["claude-opus-5-5", "anthropic/claude-opus-5-5"],
    ["gpt-6-sol", "openai/gpt-6-sol"],
    ["gpt-6-luna", "openai/gpt-6-luna"],
  ])("resolves the latest model label model:%s", (model, expected) => {
    expect(extractModelFromLabels([{ name: `model:${model}` }])).toBe(expected);
  });

  it.each(["gpt-5.2", "gpt-5.2-codex", "opus-6"])(
    "returns null for unsupported model:%s label",
    (model) => {
      expect(extractModelFromLabels([{ name: `model:${model}` }])).toBeNull();
    }
  );

  it("returns null for unknown model label", () => {
    expect(extractModelFromLabels([{ name: "model:unknown-model" }])).toBeNull();
  });

  it("returns null when no model labels present", () => {
    expect(extractModelFromLabels([{ name: "bug" }, { name: "urgent" }])).toBeNull();
  });

  it("returns null for empty labels", () => {
    expect(extractModelFromLabels([])).toBeNull();
  });
});

// ─── resolveStaticTarget ────────────────────────────────────────────────────

describe("resolveStaticTarget", () => {
  const mapping = {
    "team-1": [
      { owner: "org", name: "frontend", label: "frontend" },
      { owner: "org", name: "backend", label: "backend" },
      { owner: "org", name: "default-repo" },
    ],
  };

  it("matches by label", () => {
    const result = resolveStaticTarget(mapping, "team-1", ["Frontend"]);
    expect(result).toEqual({ owner: "org", name: "frontend", label: "frontend" });
  });

  it("falls back to entry without label", () => {
    const result = resolveStaticTarget(mapping, "team-1", ["unrelated"]);
    expect(result).toEqual({ owner: "org", name: "default-repo" });
  });

  it("returns null for empty mapping", () => {
    expect(resolveStaticTarget({}, "team-1")).toBeNull();
  });

  it("returns null for unknown team", () => {
    expect(resolveStaticTarget(mapping, "team-unknown")).toBeNull();
  });

  it("matches an environment entry by label", () => {
    const mixed = {
      "team-1": [
        { environmentId: "env_fullstack", label: "fullstack" },
        { owner: "org", name: "default-repo" },
      ],
    };
    expect(resolveStaticTarget(mixed, "team-1", ["Fullstack"])).toEqual({
      environmentId: "env_fullstack",
      label: "fullstack",
    });
  });

  it("falls back to a label-less environment entry", () => {
    const mixed = {
      "team-1": [
        { owner: "org", name: "frontend", label: "frontend" },
        { environmentId: "env_fullstack" },
      ],
    };
    expect(resolveStaticTarget(mixed, "team-1", [])).toEqual({ environmentId: "env_fullstack" });
  });
});

describe("resolveSessionModelSettings", () => {
  it("uses integration model when overrides are disabled", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "high",
      allowUserPreferenceOverride: false,
      allowLabelModelOverride: false,
      userModel: "openai/gpt-5.3-codex",
      labelModel: "anthropic/claude-opus-4-6",
    });

    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("applies user preference when enabled", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: false,
      userModel: "openai/gpt-5.3-codex",
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("openai/gpt-5.3-codex");
    expect(result.reasoningEffort).toBe("xhigh");
  });

  it("does not let config effort override user effort when user model wins", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "low",
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: false,
      userModel: "openai/gpt-5.3-codex",
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("openai/gpt-5.3-codex");
    expect(result.reasoningEffort).toBe("xhigh");
  });

  it("applies label override over user preference when enabled", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: null,
      configReasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      userModel: "openai/gpt-5.3-codex",
      labelModel: "anthropic/claude-opus-4-6",
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("falls back to model default reasoning effort when invalid", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-opus-4-6",
      configReasoningEffort: "xhigh",
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: false,
      userReasoningEffort: "xhigh",
    });

    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reasoningEffort).toBe("high");
  });

  it("uses config reasoning effort when config model is selected", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: "anthropic/claude-haiku-4-5",
      configModel: "anthropic/claude-opus-4-6",
      configReasoningEffort: "max",
      allowUserPreferenceOverride: false,
      allowLabelModelOverride: false,
      userReasoningEffort: "low",
    });

    expect(result.model).toBe("anthropic/claude-opus-4-6");
    expect(result.reasoningEffort).toBe("max");
  });
});

// ─── cancelPlanFrom ──────────────────────────────────────────────────────────

describe("cancelPlanFrom", () => {
  const statuses = (stage: Parameters<typeof cancelPlanFrom>[0]) =>
    cancelPlanFrom(stage).map((step) => step.status);

  it("cancels every step when nothing had completed", () => {
    expect(statuses("start")).toEqual(["canceled", "canceled", "canceled", "canceled", "canceled"]);
  });

  it("keeps completed steps and cancels the rest", () => {
    expect(statuses("repo_resolved")).toEqual([
      "completed",
      "completed",
      "canceled",
      "canceled",
      "canceled",
    ]);
    expect(statuses("session_created")).toEqual([
      "completed",
      "completed",
      "completed",
      "canceled",
      "canceled",
    ]);
  });

  it("leaves a fully completed plan unchanged", () => {
    expect(cancelPlanFrom("completed")).toEqual(makePlan("completed"));
  });

  it("preserves the step labels and order", () => {
    expect(cancelPlanFrom("start").map((step) => step.content)).toEqual(
      makePlan("start").map((step) => step.content)
    );
  });
});

// ─── buildRepoSelectOptions ─────────────────────────────────────────────────

describe("buildRepoSelectOptions", () => {
  const repo = (owner: string, name: string): RepoConfig => ({
    id: `${owner}/${name}`,
    owner,
    name,
    fullName: `${owner}/${name}`,
    displayName: name,
    description: name,
    defaultBranch: "main",
    private: true,
  });
  const backend = repo("acme", "backend");
  const frontend = repo("acme", "frontend");
  const infra = repo("acme", "infra");
  const docs = repo("acme", "docs");
  const repos = [backend, frontend, infra, docs];

  it("orders confident Linear suggestions first, then the classifier pick, then alternatives", () => {
    expect(
      buildRepoSelectOptions({
        classified: infra,
        alternatives: [docs],
        suggestions: [
          { repositoryFullName: "acme/backend", confidence: 0.6 },
          { repositoryFullName: "acme/frontend", confidence: 0.9 },
        ],
        repos,
      })
    ).toEqual([
      { value: "acme/frontend" },
      { value: "acme/backend" },
      { value: "acme/infra" },
      { value: "acme/docs" },
    ]);
  });

  it("drops suggestions below the confidence threshold", () => {
    expect(
      buildRepoSelectOptions({
        classified: null,
        alternatives: [],
        suggestions: [
          { repositoryFullName: "acme/backend", confidence: SUGGESTION_OPTION_MIN_CONFIDENCE },
          {
            repositoryFullName: "acme/frontend",
            confidence: SUGGESTION_OPTION_MIN_CONFIDENCE - 0.01,
          },
        ],
        repos,
      })
    ).toEqual([{ value: "acme/backend" }]);
  });

  it("dedupes case-insensitively and returns the launchable spelling", () => {
    expect(
      buildRepoSelectOptions({
        classified: backend,
        alternatives: [backend, frontend],
        suggestions: [{ repositoryFullName: "Acme/Backend", confidence: 0.8 }],
        repos,
      })
    ).toEqual([{ value: "acme/backend" }, { value: "acme/frontend" }]);
  });

  it("offers only repositories that can be launched", () => {
    expect(
      buildRepoSelectOptions({
        classified: repo("other", "unknown"),
        alternatives: [repo("acme", "retired")],
        suggestions: [{ repositoryFullName: "acme/archived", confidence: 0.95 }],
        repos: [backend],
      })
    ).toEqual([]);
  });

  it("caps the list at MAX_SELECT_OPTIONS", () => {
    const many = Array.from({ length: MAX_SELECT_OPTIONS + 4 }, (_, i) =>
      repo("acme", `repo-${i}`)
    );

    const options = buildRepoSelectOptions({
      classified: null,
      alternatives: many,
      suggestions: [],
      repos: many,
    });

    expect(options).toHaveLength(MAX_SELECT_OPTIONS);
    expect(options[0]).toEqual({ value: "acme/repo-0" });
  });

  it("emits values only — Linear renders the repository name itself", () => {
    const [option] = buildRepoSelectOptions({
      classified: backend,
      alternatives: [],
      suggestions: [],
      repos,
    });

    expect(Object.keys(option)).toEqual(["value"]);
  });

  it("returns nothing when there is no candidate at all", () => {
    expect(
      buildRepoSelectOptions({ classified: null, alternatives: [], suggestions: [], repos })
    ).toEqual([]);
  });
});
