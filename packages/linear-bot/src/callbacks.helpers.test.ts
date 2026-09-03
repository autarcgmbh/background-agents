import { describe, expect, it } from "vitest";
import type { LinearCompletionCallback } from "@open-inspect/shared/types/session-api";
import {
  formatCompletionComment,
  formatToolAction,
  formatToolResult,
  isUserInitiatedTermination,
  TOOL_RESULT_MAX_CHARS,
} from "./callbacks";

// ─── formatToolAction ────────────────────────────────────────────────────────

describe("formatToolAction", () => {
  it("edit_file with filepath", () => {
    expect(formatToolAction("edit_file", { filepath: "src/main.ts" })).toEqual({
      action: "Edit",
      parameter: "src/main.ts",
    });
  });

  it("write_file with path", () => {
    expect(formatToolAction("write_file", { path: "out/bundle.js" })).toEqual({
      action: "Edit",
      parameter: "out/bundle.js",
    });
  });

  it("edit_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("edit_file", {})).toEqual({ action: "Edit", parameter: "file" });
  });

  it("read_file with filepath", () => {
    expect(formatToolAction("read_file", { filepath: "README.md" })).toEqual({
      action: "Read",
      parameter: "README.md",
    });
  });

  it("read_file with path", () => {
    expect(formatToolAction("read_file", { path: "docs/guide.md" })).toEqual({
      action: "Read",
      parameter: "docs/guide.md",
    });
  });

  it("read_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("read_file", {})).toEqual({ action: "Read", parameter: "file" });
  });

  it("bash with command", () => {
    expect(formatToolAction("bash", { command: "npm test" })).toEqual({
      action: "Run",
      parameter: "npm test",
    });
  });

  it("execute_command with cmd", () => {
    expect(formatToolAction("execute_command", { cmd: "ls -la" })).toEqual({
      action: "Run",
      parameter: "ls -la",
    });
  });

  it("bash with command >80 chars truncates to 77 + ...", () => {
    const longCmd = "a".repeat(100);
    expect(formatToolAction("bash", { command: longCmd })).toEqual({
      action: "Run",
      parameter: `${"a".repeat(77)}...`,
    });
  });

  it("bash with command exactly 80 chars is not truncated", () => {
    const cmd = "a".repeat(80);
    expect(formatToolAction("bash", { command: cmd })).toEqual({
      action: "Run",
      parameter: cmd,
    });
  });

  it("bash with no command falls back to a placeholder so parameter is never empty", () => {
    // Linear's API rejects action activities with empty `parameter` fields.
    expect(formatToolAction("bash", {})).toEqual({ action: "Run", parameter: "(no command)" });
  });

  it("unknown tool uses the tool name as action and a string arg as parameter", () => {
    expect(formatToolAction("search_files", { query: "foo" })).toEqual({
      action: "search_files",
      parameter: "foo",
    });
  });

  it("unknown tool with no string args falls back to a placeholder parameter", () => {
    expect(formatToolAction("noop", { count: 3 })).toEqual({
      action: "noop",
      parameter: "(no args)",
    });
  });

  it("unknown tool truncates very long string args to 200 chars", () => {
    const long = "x".repeat(500);
    const result = formatToolAction("fetch_url", { url: long });
    expect(result.action).toBe("fetch_url");
    expect(result.parameter).toHaveLength(200);
    expect(result.parameter).toBe("x".repeat(200));
  });
});

// ─── formatToolAction with tool output ───────────────────────────────────────

describe("formatToolAction with output", () => {
  it("attaches the fenced output as result", () => {
    expect(formatToolAction("bash", { command: "npm test" }, "12 passed")).toEqual({
      action: "Run",
      parameter: "npm test",
      result: "```\n12 passed\n```",
    });
  });

  it("attaches results for file and unknown tools alike", () => {
    expect(formatToolAction("read_file", { path: "README.md" }, "# Title")).toEqual({
      action: "Read",
      parameter: "README.md",
      result: "```\n# Title\n```",
    });
    expect(formatToolAction("search", { query: "foo" }, "3 hits")).toEqual({
      action: "search",
      parameter: "foo",
      result: "```\n3 hits\n```",
    });
  });

  it("omits result entirely when output is absent, empty or whitespace", () => {
    for (const output of [undefined, "", "   \n"]) {
      const action = formatToolAction("bash", { command: "ls" }, output);
      expect(action).toEqual({ action: "Run", parameter: "ls" });
      expect(action).not.toHaveProperty("result");
    }
  });

  it("truncates long output to the result cap with an ellipsis", () => {
    const action = formatToolAction("bash", { command: "cat log" }, "x".repeat(1000));

    const inner = action.result?.slice("```\n".length, -"\n```".length) ?? "";
    expect(inner).toHaveLength(TOOL_RESULT_MAX_CHARS);
    expect(inner.endsWith("…")).toBe(true);
    expect(inner.startsWith("x".repeat(TOOL_RESULT_MAX_CHARS - 1))).toBe(true);
  });

  it("keeps output exactly at the cap intact", () => {
    const exact = "y".repeat(TOOL_RESULT_MAX_CHARS);
    expect(formatToolResult(exact)).toBe(`\`\`\`\n${exact}\n\`\`\``);
  });

  it("trims surrounding whitespace before fencing", () => {
    expect(formatToolResult("  done \n")).toBe("```\ndone\n```");
  });
});

// ─── isUserInitiatedTermination ──────────────────────────────────────────────

describe("isUserInitiatedTermination", () => {
  const base: LinearCompletionCallback = {
    sessionId: "session-1",
    messageId: "message-1",
    success: false,
    timestamp: 1_700_000_000_000,
    signature: "sig",
    context: {
      source: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      model: "anthropic/claude-haiku-4-5",
    },
  };

  it.each(["stopped", "cancelled"] as const)("is true for terminationReason %s", (reason) => {
    expect(isUserInitiatedTermination({ ...base, terminationReason: reason })).toBe(true);
  });

  it.each(["execution_timeout", "sandbox_failure", "provider_unavailable"] as const)(
    "is false for terminationReason %s",
    (reason) => {
      expect(isUserInitiatedTermination({ ...base, terminationReason: reason })).toBe(false);
    }
  );

  it("recognizes the legacy stopped error text when no reason is present", () => {
    expect(isUserInitiatedTermination({ ...base, error: "Execution was stopped" })).toBe(true);
    expect(isUserInitiatedTermination({ ...base, error: "Sandbox crashed" })).toBe(false);
    expect(isUserInitiatedTermination(base)).toBe(false);
  });

  it("prefers the explicit reason over the legacy error text", () => {
    expect(
      isUserInitiatedTermination({
        ...base,
        terminationReason: "sandbox_failure",
        error: "Execution was stopped",
      })
    ).toBe(false);
  });

  it("is never true for a successful run", () => {
    expect(
      isUserInitiatedTermination({ ...base, success: true, terminationReason: "stopped" })
    ).toBe(false);
  });
});

// ─── formatCompletionComment ─────────────────────────────────────────────────

describe("formatCompletionComment", () => {
  it("uses the configured app name on success", () => {
    expect(formatCompletionComment("Acme Bot", true, "All set.")).toBe(
      "## 🤖 Acme Bot completed\n\nAll set."
    );
  });

  it("uses the configured app name on failure", () => {
    expect(formatCompletionComment("Acme Bot", false, "Something went wrong.")).toBe(
      "## ⚠️ Acme Bot encountered an issue\n\nSomething went wrong."
    );
  });

  it("works with the default Open-Inspect name", () => {
    expect(formatCompletionComment("Open-Inspect", true, "ok")).toBe(
      "## 🤖 Open-Inspect completed\n\nok"
    );
  });
});
