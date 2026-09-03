import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "../logger";
import {
  CallbackNotificationService,
  type CallbackRepository,
  type CallbackServiceEnv,
  type CallbackServiceDeps,
} from "./callback-notification-service";
import type { MessageRepository } from "./message-repository";
import type { EventRepository, MessageProgressSnapshot } from "./event-repository";
import type { FetchClient } from "../platform-ports";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import {
  linearCompletionCallbackSchema,
  linearProgressCallbackSchema,
  linearToolCallCallbackSchema,
  MAX_LINEAR_PROGRESS_TEXT_CHARS,
  MAX_LINEAR_TOOL_RESULT_CHARS,
} from "@open-inspect/shared/types/session-api";

const LINEAR_CALLBACK_CONTEXT = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

// ---- Mock factories ----

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createMockRepository() {
  return {
    getMessageCallbackContext: vi.fn<MessageRepository["getMessageCallbackContext"]>(() => null),
    getMessageStatus: vi.fn<MessageRepository["getMessageStatus"]>(() => "processing"),
    getSession: vi.fn(() => null),
  };
}

function createMockEventRepository() {
  return {
    getMessageProgressSnapshot: vi.fn<EventRepository["getMessageProgressSnapshot"]>(
      (): MessageProgressSnapshot => ({ toolCallCount: 0, phase: "thinking" })
    ),
  };
}

function createMockFetcher() {
  return { fetch: vi.fn<FetchClient["fetch"]>() };
}

function createTestHarness(overrides?: {
  env?: Partial<CallbackServiceEnv>;
  getSessionId?: () => string;
  completeAutomationRun?: CallbackServiceDeps["completeAutomationRun"];
}) {
  const log = createMockLogger();
  const repository = createMockRepository();
  const eventRepository = createMockEventRepository();

  const slackBot = createMockFetcher();
  const linearBot = createMockFetcher();
  const sleep = vi.fn(async () => {});

  const env: CallbackServiceEnv = {
    SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
    SERVICE_AUTH_SECRET_LINEAR_BOT: "test-secret",
    SLACK_BOT: slackBot,
    LINEAR_BOT: linearBot,
    ...overrides?.env,
  };

  const deps: CallbackServiceDeps = {
    repository: repository as CallbackRepository,
    messageRepository: repository as unknown as MessageRepository,
    eventRepository,
    env,
    log,
    getSessionId: overrides?.getSessionId ?? (() => "session-123"),
    completeAutomationRun: overrides?.completeAutomationRun,
    sleep,
  };

  return {
    service: new CallbackNotificationService(deps),
    repository,
    eventRepository,
    log,
    env,
    slackBot,
    linearBot,
    sleep,
  };
}

// ---- Tests ----

describe("CallbackNotificationService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  describe("notifyComplete", () => {
    it("skips when no callback context", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue(null);

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "rejected",
          reject_reason: "no_callback_context",
          duration_ms: expect.any(Number),
        })
      );
      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("skips when callback_context is null on the message", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: null,
        source: "slack",
      });

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("absorbs and logs unexpected callback failures", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: "{",
        source: "slack",
      });

      await expect(harness.service.notifyComplete("msg-1", true)).resolves.toBeUndefined();

      expect(harness.log.error).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          message_id: "msg-1",
          outcome: "error",
          error: expect.any(SyntaxError),
        })
      );
    });

    it("absorbs session identity lookup failures", async () => {
      const sessionError = new Error("session unavailable");
      const h = createTestHarness({
        getSessionId: () => {
          throw sessionError;
        },
      });

      await expect(h.service.notifyComplete("msg-1", true)).resolves.toBeUndefined();

      expect(h.log.error).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          session_id: null,
          message_id: "msg-1",
          outcome: "error",
          error: sessionError,
        })
      );
    });

    it("skips when the destination bot's signing secret is unbound", async () => {
      const h = createTestHarness({
        env: {
          SERVICE_AUTH_SECRET_SLACK_BOT: undefined,
          SERVICE_AUTH_SECRET_LINEAR_BOT: undefined,
        },
      });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(h.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("skips when no binding for source", async () => {
      const h = createTestHarness({
        env: { SLACK_BOT: undefined, LINEAR_BOT: undefined },
      });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          source: "slack",
          outcome: "rejected",
          reject_reason: "no_binding",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("calls binding with signed payload on success", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123", threadTs: "1234.5678" }),
        source: "slack",
      });

      const mockResponse = new Response("ok", { status: 200 });
      vi.mocked(harness.slackBot.fetch).mockResolvedValue(mockResponse);

      await harness.service.notifyComplete("msg-1", true);

      const fetchMock = harness.slackBot.fetch;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/complete",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      // Verify payload shape
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-1",
        success: true,
        context: { channel: "C123", threadTs: "1234.5678" },
      });
      expect(body.signature).toEqual(expect.any(String));
      expect(body.timestamp).toEqual(expect.any(Number));

      const terminalEvents = vi
        .mocked(harness.log.info)
        .mock.calls.filter(([event]) => event === "callback.complete_delivery");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0][1]).toEqual(
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          source: "slack",
          outcome: "success",
          duration_ms: expect.any(Number),
          attempts: 1,
          retries: 0,
          http_status: 200,
        })
      );
    });

    it("retries once on fetch failure", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      const fetchMock = vi.mocked(harness.slackBot.fetch);
      fetchMock
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await harness.service.notifyComplete("msg-1", true);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({ message_id: "msg-1", attempts: 2, retries: 1 })
      );
    });

    it("emits one terminal event after retries are exhausted", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });
      harness.slackBot.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

      await harness.service.notifyComplete("msg-1", false);

      const terminalEvents = vi
        .mocked(harness.log.error)
        .mock.calls.filter(([event]) => event === "callback.complete_delivery");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0][1]).toEqual(
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "error",
          duration_ms: expect.any(Number),
          attempts: 2,
          retries: 1,
          http_status: 503,
        })
      );
    });

    it("does not report a stale HTTP status when the final attempt throws", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });
      harness.slackBot.fetch
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockRejectedValueOnce(new Error("network error"));

      await harness.service.notifyComplete("msg-1", false);

      const terminalEvent = vi
        .mocked(harness.log.error)
        .mock.calls.find(([event]) => event === "callback.complete_delivery");
      expect(terminalEvent?.[1]).toEqual(
        expect.objectContaining({ outcome: "error", attempts: 2, retries: 1 })
      );
      expect(terminalEvent?.[1]).not.toHaveProperty("http_status");
    });

    it("routes to LINEAR_BOT for linear source", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: " issue-1 ",
          issueIdentifier: "LIN-123",
          issueUrl: "https://linear.app/acme/issue/LIN-123",
          model: "anthropic/claude-haiku-4-5",
        }),
        source: "linear",
      });

      const mockResponse = new Response("ok", { status: 200 });
      vi.mocked(harness.linearBot.fetch).mockResolvedValue(mockResponse);

      await harness.service.notifyComplete("msg-1", false);

      const linearFetch = harness.linearBot.fetch;
      expect(linearFetch).toHaveBeenCalledTimes(1);

      const slackFetch = harness.slackBot.fetch;
      expect(slackFetch).not.toHaveBeenCalled();

      const body = JSON.parse(String(linearFetch.mock.calls[0][1]?.body));
      expect(body.context.issueId).toBe("issue-1");
      expect(linearCompletionCallbackSchema.safeParse(body).success).toBe(true);
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
    });
  });

  describe("notifyComplete — termination reason", () => {
    beforeEach(() => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });
      harness.linearBot.fetch.mockResolvedValue(new Response("ok", { status: 200 }));
    });

    it("includes terminationReason in the Linear payload when provided", async () => {
      await harness.service.notifyComplete("msg-1", false, "Execution was stopped", {
        terminationReason: "stopped",
      });

      const body = JSON.parse(String(harness.linearBot.fetch.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        success: false,
        error: "Execution was stopped",
        terminationReason: "stopped",
      });
      expect(linearCompletionCallbackSchema.safeParse(body).success).toBe(true);
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
    });

    it("omits terminationReason when none is provided", async () => {
      await harness.service.notifyComplete("msg-1", true);

      const body = JSON.parse(String(harness.linearBot.fetch.mock.calls[0][1]?.body));
      expect(body).not.toHaveProperty("terminationReason");
      expect(linearCompletionCallbackSchema.safeParse(body).success).toBe(true);
    });
  });

  describe("notifyProgress", () => {
    const linearContext = () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });
    };

    it("skips when the message has no callback context", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: null,
        source: "linear",
      });

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.progress",
        expect.objectContaining({ outcome: "skipped", skip_reason: "no_callback_context" })
      );
    });

    it("skips non-Linear sources", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.progress",
        expect.objectContaining({ outcome: "skipped", skip_reason: "non_linear_source" })
      );
    });

    it("skips when the Linear signing secret is unbound", async () => {
      harness = createTestHarness({ env: { SERVICE_AUTH_SECRET_LINEAR_BOT: undefined } });
      linearContext();

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.progress",
        expect.objectContaining({ outcome: "skipped", skip_reason: "no_secret" })
      );
    });

    it("skips when the Linear binding is missing", async () => {
      harness = createTestHarness({ env: { LINEAR_BOT: undefined } });
      linearContext();

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.progress",
        expect.objectContaining({ outcome: "skipped", skip_reason: "no_binding" })
      );
    });

    it("skips when the message is no longer processing", async () => {
      linearContext();
      vi.mocked(harness.repository.getMessageStatus).mockReturnValue("completed");

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.eventRepository.getMessageProgressSnapshot).not.toHaveBeenCalled();
      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.progress",
        expect.objectContaining({ outcome: "skipped", skip_reason: "message_not_processing" })
      );
    });

    it("posts a signed, schema-valid progress snapshot with a single attempt", async () => {
      linearContext();
      const longText = "x".repeat(MAX_LINEAR_PROGRESS_TEXT_CHARS);
      harness.eventRepository.getMessageProgressSnapshot.mockReturnValue({
        toolCallCount: 3,
        phase: "tool_call",
        currentTool: { tool: "bash", callId: "call-3", status: "running" },
        latestText: longText,
      });
      harness.linearBot.fetch.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyProgress("msg-1", { trigger: "step_finish", elapsedMs: 42_000 });

      expect(harness.linearBot.fetch).toHaveBeenCalledOnce();
      expect(harness.linearBot.fetch).toHaveBeenCalledWith(
        "https://internal/callbacks/progress",
        expect.objectContaining({ method: "POST" })
      );
      const body = JSON.parse(String(harness.linearBot.fetch.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-1",
        elapsedMs: 42_000,
        trigger: "step_finish",
        toolCallCount: 3,
        phase: "tool_call",
        currentTool: { tool: "bash", callId: "call-3", status: "running" },
        latestText: longText,
        latestTextComplete: true,
        context: LINEAR_CALLBACK_CONTEXT,
        timestamp: expect.any(Number),
      });
      expect(body.latestText).toHaveLength(MAX_LINEAR_PROGRESS_TEXT_CHARS);
      expect(linearProgressCallbackSchema.safeParse(body).success).toBe(true);
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.progress_delivery",
        expect.objectContaining({
          message_id: "msg-1",
          trigger: "step_finish",
          outcome: "success",
          attempts: 1,
          http_status: 200,
          duration_ms: expect.any(Number),
        })
      );
    });

    it("marks heartbeat text as a mid-stream snapshot", async () => {
      linearContext();
      harness.eventRepository.getMessageProgressSnapshot.mockReturnValue({
        toolCallCount: 0,
        phase: "responding",
        latestText: "Working on it",
      });
      harness.linearBot.fetch.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 300_000 });

      const body = JSON.parse(String(harness.linearBot.fetch.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        trigger: "heartbeat",
        phase: "responding",
        latestText: "Working on it",
        latestTextComplete: false,
      });
      expect(body).not.toHaveProperty("currentTool");
    });

    it("does not retry a failed progress delivery", async () => {
      linearContext();
      harness.linearBot.fetch.mockResolvedValue(new Response("nope", { status: 500 }));

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.linearBot.fetch).toHaveBeenCalledOnce();
      expect(harness.sleep).not.toHaveBeenCalled();
      expect(harness.log.warn).toHaveBeenCalledWith(
        "callback.progress_delivery",
        expect.objectContaining({ outcome: "error", attempts: 1, http_status: 500 })
      );
    });

    it("rejects a payload that fails the shared schema before signing", async () => {
      linearContext();
      harness.eventRepository.getMessageProgressSnapshot.mockReturnValue({
        toolCallCount: 0,
        phase: "thinking",
        latestText: "y".repeat(MAX_LINEAR_PROGRESS_TEXT_CHARS + 1),
      });

      await harness.service.notifyProgress("msg-1", { trigger: "heartbeat", elapsedMs: 1000 });

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.warn).toHaveBeenCalledWith(
        "callback.progress",
        expect.objectContaining({ outcome: "skipped", skip_reason: "invalid_payload" })
      );
    });
  });

  describe("notifyStarted", () => {
    it("sends an authenticated start callback for a Linear message", async () => {
      const context = {
        source: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        model: "anthropic/claude-haiku-4-5",
        organizationId: "org-1",
        appUserId: "app-user-1",
        transitionIssueOnStart: true,
      };
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(context),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/start",
        expect.objectContaining({ method: "POST" })
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-1",
        context,
        timestamp: expect.any(Number),
        signature: expect.any(String),
      });
      expect(body).not.toHaveProperty("success");
      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("retries a failed start callback once", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: "issue-1",
          transitionIssueOnStart: true,
        }),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock
        .mockResolvedValueOnce(new Response("retry", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(harness.sleep).toHaveBeenCalledWith(1000);
      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.started_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "success",
          attempts: 2,
          retries: 1,
          http_status: 200,
          duration_ms: expect.any(Number),
        })
      );
    });

    it("retries when failure logging throws", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ source: "linear", issueId: "issue-1" }),
        source: "linear",
      });
      harness.linearBot.fetch
        .mockResolvedValueOnce(new Response("retry", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      vi.mocked(harness.log.warn).mockImplementationOnce(() => {
        throw new Error("log sink unavailable");
      });

      await harness.service.notifyStarted("msg-1");

      expect(harness.linearBot.fetch).toHaveBeenCalledTimes(2);
    });

    it("contains start callback failure after the bounded retry", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: "issue-1",
          transitionIssueOnStart: true,
        }),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockRejectedValue(new Error("network unavailable"));

      await expect(harness.service.notifyStarted("msg-1")).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(harness.log.error).toHaveBeenCalledWith(
        "callback.started_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "error",
          attempts: 2,
          retries: 1,
          duration_ms: expect.any(Number),
        })
      );
    });

    it("forwards opaque Linear context without interpreting transition policy", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: "issue-1",
          transitionIssueOnStart: false,
        }),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body.context).toEqual({
        source: "linear",
        issueId: "issue-1",
        transitionIssueOnStart: false,
      });
    });

    it.each(["{not-json", "null"])(
      "ignores invalid stored callback context: %s",
      async (context) => {
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: context,
          source: "linear",
        });

        await expect(harness.service.notifyStarted("msg-1")).resolves.toBeUndefined();
        expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      }
    );
  });

  describe("notifyToolCall", () => {
    it("skips when throttled (< 3s since last call)", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      const fetchMock = vi.mocked(harness.slackBot.fetch);
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      // First call should go through
      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call within 3s should be throttled
      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
      expect(fetchMock).toHaveBeenCalledTimes(1); // still 1
    });

    it("fires callback on first call", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });

      const fetchMock = vi.mocked(harness.linearBot.fetch);
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "bash",
        args: { cmd: "ls" },
        callId: "call-1",
        status: "running",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/tool_call",
        expect.objectContaining({ method: "POST" })
      );

      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        sessionId: "session-123",
        tool: "bash",
        args: { cmd: "ls" },
        callId: "call-1",
        status: "running",
        context: expect.objectContaining({ source: "linear", issueId: "issue-1" }),
      });
      expect(body.signature).toEqual(expect.any(String));
      expect(linearToolCallCallbackSchema.safeParse(body).success).toBe(true);
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
    });

    it("skips Linear callbacks whose tool arguments are missing", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "bash",
        callId: "call-1",
      });

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.warn).toHaveBeenCalledWith(
        "callback.tool_call",
        expect.objectContaining({ outcome: "skipped", skip_reason: "invalid_payload" })
      );
    });

    it("skips automation source because the scheduler has no tool-call consumer", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ automationId: "a1", runId: "r1" }),
        source: "automation",
      });

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "glob",
        callId: "call-1",
      });

      // No forward at all; automation callbacks only report completion.
      const slackFetch = harness.slackBot.fetch;
      expect(slackFetch).not.toHaveBeenCalled();
      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.tool_call",
        expect.objectContaining({
          source: "automation",
          outcome: "skipped",
          skip_reason: "automation_no_consumer",
        })
      );
    });

    it("skips when no callback context", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue(null);

      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

      const fetchMock = harness.slackBot.fetch;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips when no secret configured", async () => {
      const h = createTestHarness({
        env: {
          SERVICE_AUTH_SECRET_SLACK_BOT: undefined,
          SERVICE_AUTH_SECRET_LINEAR_BOT: undefined,
        },
      });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

      const fetchMock = h.slackBot.fetch;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("dedup by callId", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("fires once per lifecycle stage per callId: one start and one terminal delivery", async () => {
        // Anthropic emits running+completed for the same tool. OpenAI's
        // Responses API may report only completed. Either way, at most one
        // start and one finish per callId.
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-abc",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // A second non-terminal event for the same callId is a duplicate.
        vi.setSystemTime(start + 5_000);
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-abc",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-abc",
          status: "completed",
          output: "done",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Once the terminal status is delivered, nothing more for this callId.
        vi.setSystemTime(start + 10_000);
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-abc",
          status: "completed",
          output: "done",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("delivers the terminal status with a truncated result for Linear", async () => {
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
          source: "linear",
        });
        const fetchMock = harness.linearBot.fetch;
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
        const output = "o".repeat(MAX_LINEAR_TOOL_RESULT_CHARS + 25);

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { cmd: "ls" },
          callId: "call-1",
          status: "running",
          output: "ignored while running",
        });
        const startBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
        expect(startBody).not.toHaveProperty("result");
        expect(startBody).not.toHaveProperty("resultTruncated");

        vi.setSystemTime(start + 5_000);
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { cmd: "ls" },
          callId: "call-1",
          status: "completed",
          output,
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
        expect(body).toMatchObject({
          callId: "call-1",
          status: "completed",
          result: "o".repeat(MAX_LINEAR_TOOL_RESULT_CHARS),
          resultTruncated: true,
        });
        expect(linearToolCallCallbackSchema.safeParse(body).success).toBe(true);
        expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
      });

      it("omits the result for an error status without output", async () => {
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
          source: "linear",
        });
        harness.linearBot.fetch.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { cmd: "ls" },
          callId: "call-err",
          status: "error",
        });

        const body = JSON.parse(String(harness.linearBot.fetch.mock.calls[0][1]?.body));
        expect(body.status).toBe("error");
        expect(body).not.toHaveProperty("result");
        expect(body).not.toHaveProperty("resultTruncated");
        expect(linearToolCallCallbackSchema.safeParse(body).success).toBe(true);
      });

      it("lets a terminal status bypass the throttle only when its start was delivered", async () => {
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-a",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Inside the throttle window: a terminal for an undelivered callId waits...
        vi.setSystemTime(start + 1_000);
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "read",
          callId: "call-b",
          status: "completed",
          output: "contents",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // ...while the terminal for the delivered start goes straight through.
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-a",
          status: "completed",
          output: "ok",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
        expect(body).toMatchObject({ callId: "call-a", status: "completed", result: "ok" });
      });

      it("does not throttle a valid Linear callback after rejecting an invalid one", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
          source: "linear",
        });
        harness.linearBot.fetch.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { command: "invalid without callId" },
        });
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { command: "valid" },
          callId: "call-valid",
        });

        expect(harness.linearBot.fetch).toHaveBeenCalledOnce();
      });

      it("fires a start and a finish per distinct callId across many tool calls", async () => {
        vi.useFakeTimers();
        let now = 1_700_000_000_000;
        vi.setSystemTime(now);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        for (let i = 0; i < 3; i++) {
          // Each tool emits running then completed; the finish follows its own
          // delivered start without waiting out the throttle window.
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "running",
          });
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "completed",
          });
          // A repeated terminal event is a duplicate.
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "completed",
          });
          now += 3_001;
          vi.setSystemTime(now);
        }

        expect(fetchMock).toHaveBeenCalledTimes(6);
      });

      it("evicts the oldest callId (FIFO) once the cap is exceeded", async () => {
        vi.useFakeTimers();
        let now = 1_700_000_000_000;
        vi.setSystemTime(now);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        // Cap is 500. Fire 501 distinct callIds; the first one ("call-0")
        // should be evicted when "call-500" is admitted.
        for (let i = 0; i <= 500; i++) {
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "running",
          });
          now += 3_001;
          vi.setSystemTime(now);
        }
        expect(fetchMock).toHaveBeenCalledTimes(501);

        // call-0 was evicted, so a re-fire is treated as a fresh tool call
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-0",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(502);

        // call-1 is still in the set (it became the new oldest), so it dedupes
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-1",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(502);
      });

      it("falls back to throttle-only behavior when callId is missing", async () => {
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // No callId on either event — second event past throttle should fire
        vi.setSystemTime(start + 5_000);
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("retries on a later event when the first delivery for a callId fails", async () => {
        // markCallIdNotified runs only on response.ok, so a transient failure
        // (e.g. network error or non-2xx) on Anthropic's "running" event must
        // not prevent the subsequent "completed" event from re-delivering.
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock
          .mockRejectedValueOnce(new Error("network"))
          .mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-retry",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Advance past the throttle window so the retry is eligible.
        vi.setSystemTime(start + 5_000);

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-retry",
          status: "completed",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Third event for the same callId after a successful delivery should dedupe.
        vi.setSystemTime(start + 10_000);
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-retry",
          status: "completed",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("notifyComplete — automation callback", () => {
    it("routes automation callbacks to the injected completion function", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({
        completeAutomationRun,
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(completeAutomationRun).toHaveBeenCalledTimes(1);
      expect(completeAutomationRun).toHaveBeenCalledWith({
        automationId: "auto-1",
        runId: "run-1",
        sessionId: "session-123",
        messageId: "msg-1",
        success: true,
        error: undefined,
        automationName: "Daily sync",
      });
    });

    it("sends failure details for failed automation runs", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({
        completeAutomationRun,
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", false, "Sandbox crashed");

      expect(completeAutomationRun).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "Sandbox crashed",
        })
      );
    });

    it("skips when no automation completion function is configured", async () => {
      const h = createTestHarness();

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      const terminalEvents = vi
        .mocked(h.log.info)
        .mock.calls.filter(([event]) => event === "callback.complete_delivery");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0][1]).toEqual(
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          source: "automation",
          outcome: "rejected",
          reject_reason: "no_binding",
          duration_ms: expect.any(Number),
          attempts: 0,
          retries: 0,
        })
      );
    });

    it("retries once on automation callback failure", async () => {
      const completeAutomationRun = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(undefined);
      const h = createTestHarness({
        completeAutomationRun,
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(completeAutomationRun).toHaveBeenCalledTimes(2);
      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({ source: "automation", attempts: 2, retries: 1 })
      );
    });

    it("rejects malformed persisted automation context before scheduler completion", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({ completeAutomationRun });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(completeAutomationRun).not.toHaveBeenCalled();
      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          source: "automation",
          outcome: "rejected",
          reject_reason: "invalid_callback_context",
          attempts: 0,
        })
      );
    });

    it("does not route automation callbacks to SLACK_BOT", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({
        completeAutomationRun,
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      const slackFetch = h.slackBot.fetch;
      expect(slackFetch).not.toHaveBeenCalled();
    });
  });
});
