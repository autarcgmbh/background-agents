import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Logger } from "../logger";
import type { MessageProgressSnapshot } from "./event-repository";
import type { ProcessingProgressCandidate } from "./message-repository";
import {
  createProgressKeepalive,
  PROGRESS_KEEPALIVE_INTERVAL_MS,
  PROGRESS_KEEPALIVE_TOLERANCE_MS,
  PROGRESS_TEXT_UPDATE_MIN_GAP_MS,
} from "./progress-keepalive";

const STARTED_AT = 1_700_000_000_000;

function linearCandidate(
  overrides: Partial<ProcessingProgressCandidate> = {}
): ProcessingProgressCandidate {
  return {
    id: "msg-linear",
    source: "linear",
    callback_context: JSON.stringify({ source: "linear", issueId: "issue-1" }),
    started_at: STARTED_AT,
    progress_notified_at: null,
    stop_confirmation_deadline: null,
    ...overrides,
  };
}

function createHarness(options: { now?: number } = {}) {
  let now = options.now ?? STARTED_AT;
  const messageRepository = {
    getProcessingProgressCandidate: vi.fn((): ProcessingProgressCandidate | null => null),
    markProgressNotified: vi.fn((_messageId: string, _at: number) => {}),
  };
  const eventRepository = {
    getMessageProgressSnapshot: vi.fn(
      (): MessageProgressSnapshot => ({ toolCallCount: 0, phase: "thinking" })
    ),
  };
  const callbackService = {
    notifyProgress: vi.fn(async () => {}),
  };
  const alarmScheduler = { schedule: vi.fn(async (_at: number) => {}) };
  const backgroundTasks = createTestBackgroundTasks();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const keepalive = createProgressKeepalive({
    messageRepository,
    eventRepository,
    callbackService,
    alarmScheduler,
    backgroundTasks,
    now: () => now,
    log,
  });

  return {
    keepalive,
    messageRepository,
    eventRepository,
    callbackService,
    alarmScheduler,
    backgroundTasks,
    log,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("createProgressKeepalive", () => {
  describe("armForDispatch", () => {
    it("schedules the first heartbeat one interval after dispatch for a Linear message", async () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());

      await h.keepalive.armForDispatch("msg-linear", STARTED_AT);

      expect(h.alarmScheduler.schedule).toHaveBeenCalledWith(
        STARTED_AT + PROGRESS_KEEPALIVE_INTERVAL_MS
      );
    });

    it("ignores messages from other sources", async () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(
        linearCandidate({ source: "slack", callback_context: JSON.stringify({ channel: "C1" }) })
      );

      await h.keepalive.armForDispatch("msg-linear", STARTED_AT);

      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
    });

    it("ignores Linear messages without a callback context", async () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(
        linearCandidate({ callback_context: null })
      );

      await h.keepalive.armForDispatch("msg-linear", STARTED_AT);

      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
    });

    it("ignores a message that is not the processing one", async () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(
        linearCandidate({ id: "msg-other" })
      );

      await h.keepalive.armForDispatch("msg-linear", STARTED_AT);

      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
    });
  });

  describe("tick", () => {
    it("does nothing without a processing message", async () => {
      const h = createHarness();

      await h.keepalive.tick();

      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.messageRepository.markProgressNotified).not.toHaveBeenCalled();
      expect(h.backgroundTasks.submissions).toHaveLength(0);
    });

    it("does nothing for a message awaiting stop confirmation", async () => {
      const h = createHarness({ now: STARTED_AT + PROGRESS_KEEPALIVE_INTERVAL_MS });
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(
        linearCandidate({ stop_confirmation_deadline: STARTED_AT + 15_000 })
      );

      await h.keepalive.tick();

      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.backgroundTasks.submissions).toHaveLength(0);
    });

    it("re-asserts the deadline when woken before the heartbeat is due", async () => {
      const h = createHarness({ now: STARTED_AT + 60_000 });
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());

      await h.keepalive.tick();

      expect(h.alarmScheduler.schedule).toHaveBeenCalledWith(
        STARTED_AT + PROGRESS_KEEPALIVE_INTERVAL_MS
      );
      expect(h.messageRepository.markProgressNotified).not.toHaveBeenCalled();
      expect(h.backgroundTasks.submissions).toHaveLength(0);
    });

    it("treats an alarm just inside the tolerance as due", async () => {
      const now = STARTED_AT + PROGRESS_KEEPALIVE_INTERVAL_MS - PROGRESS_KEEPALIVE_TOLERANCE_MS;
      const h = createHarness({ now });
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());

      await h.keepalive.tick();

      expect(h.messageRepository.markProgressNotified).toHaveBeenCalledWith("msg-linear", now);
    });

    it("marks, submits a heartbeat, and reschedules when due", async () => {
      const now = STARTED_AT + PROGRESS_KEEPALIVE_INTERVAL_MS + 250;
      const h = createHarness({ now });
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());

      await h.keepalive.tick();
      await h.backgroundTasks.settle();

      expect(h.messageRepository.markProgressNotified).toHaveBeenCalledWith("msg-linear", now);
      expect(h.backgroundTasks.submissions).toEqual([
        expect.objectContaining({ name: "callback.notify_progress" }),
      ]);
      expect(h.callbackService.notifyProgress).toHaveBeenCalledWith("msg-linear", {
        trigger: "heartbeat",
        elapsedMs: PROGRESS_KEEPALIVE_INTERVAL_MS + 250,
      });
      expect(h.alarmScheduler.schedule).toHaveBeenCalledWith(now + PROGRESS_KEEPALIVE_INTERVAL_MS);
      // The mark lands before delivery is even queued.
      expect(h.messageRepository.markProgressNotified.mock.invocationCallOrder[0]).toBeLessThan(
        h.callbackService.notifyProgress.mock.invocationCallOrder[0]
      );
    });

    it("anchors the next heartbeat on the last progress callback rather than the start", async () => {
      const notifiedAt = STARTED_AT + 4 * 60_000;
      const now = STARTED_AT + PROGRESS_KEEPALIVE_INTERVAL_MS + 30_000;
      const h = createHarness({ now });
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(
        linearCandidate({ progress_notified_at: notifiedAt })
      );

      await h.keepalive.tick();

      expect(h.alarmScheduler.schedule).toHaveBeenCalledWith(
        notifiedAt + PROGRESS_KEEPALIVE_INTERVAL_MS
      );
      expect(h.backgroundTasks.submissions).toHaveLength(0);
    });
  });

  describe("onStepFinish", () => {
    function textSnapshot(text: string): MessageProgressSnapshot {
      return { toolCallCount: 1, phase: "tool_call", latestText: text };
    }

    it("submits a step_finish progress callback for new text and resets the heartbeat anchor", async () => {
      const now = STARTED_AT + 20_000;
      const h = createHarness({ now });
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());
      h.eventRepository.getMessageProgressSnapshot.mockReturnValue(textSnapshot("Looking around"));

      h.keepalive.onStepFinish("msg-linear", "tool-calls", now);
      await h.backgroundTasks.settle();

      expect(h.messageRepository.markProgressNotified).toHaveBeenCalledWith("msg-linear", now);
      expect(h.callbackService.notifyProgress).toHaveBeenCalledWith("msg-linear", {
        trigger: "step_finish",
        elapsedMs: 20_000,
      });
    });

    it("skips the final segment; it arrives through the completion callback", () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());
      h.eventRepository.getMessageProgressSnapshot.mockReturnValue(textSnapshot("Done."));

      h.keepalive.onStepFinish("msg-linear", "stop", STARTED_AT + 20_000);

      expect(h.eventRepository.getMessageProgressSnapshot).not.toHaveBeenCalled();
      expect(h.backgroundTasks.submissions).toHaveLength(0);
    });

    it("ignores non-Linear messages and empty text", () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(
        linearCandidate({ source: "web", callback_context: null })
      );
      h.keepalive.onStepFinish("msg-linear", "tool-calls", STARTED_AT + 20_000);
      expect(h.backgroundTasks.submissions).toHaveLength(0);

      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());
      h.eventRepository.getMessageProgressSnapshot.mockReturnValue({
        toolCallCount: 1,
        phase: "tool_call",
      });
      h.keepalive.onStepFinish("msg-linear", "tool-calls", STARTED_AT + 20_000);
      expect(h.backgroundTasks.submissions).toHaveLength(0);
      expect(h.messageRepository.markProgressNotified).not.toHaveBeenCalled();
    });

    it("dedupes unchanged text and delivers once it changes", () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());
      h.eventRepository.getMessageProgressSnapshot.mockReturnValue(textSnapshot("Step one"));

      h.keepalive.onStepFinish("msg-linear", "tool-calls", STARTED_AT + 20_000);
      h.keepalive.onStepFinish(
        "msg-linear",
        "tool-calls",
        STARTED_AT + 20_000 + PROGRESS_TEXT_UPDATE_MIN_GAP_MS
      );
      expect(h.backgroundTasks.submissions).toHaveLength(1);
      expect(h.log.debug).toHaveBeenCalledWith(
        "progress_keepalive.step_finish",
        expect.objectContaining({ skip_reason: "unchanged_text" })
      );

      h.eventRepository.getMessageProgressSnapshot.mockReturnValue(textSnapshot("Step two"));
      h.keepalive.onStepFinish(
        "msg-linear",
        "tool-calls",
        STARTED_AT + 20_000 + 2 * PROGRESS_TEXT_UPDATE_MIN_GAP_MS
      );
      expect(h.backgroundTasks.submissions).toHaveLength(2);
    });

    it("throttles changed text within the minimum gap", () => {
      const h = createHarness();
      h.messageRepository.getProcessingProgressCandidate.mockReturnValue(linearCandidate());
      h.eventRepository.getMessageProgressSnapshot.mockReturnValue(textSnapshot("Step one"));
      h.keepalive.onStepFinish("msg-linear", "tool-calls", STARTED_AT + 20_000);

      h.eventRepository.getMessageProgressSnapshot.mockReturnValue(textSnapshot("Step two"));
      h.keepalive.onStepFinish(
        "msg-linear",
        "tool-calls",
        STARTED_AT + 20_000 + PROGRESS_TEXT_UPDATE_MIN_GAP_MS - 1
      );

      expect(h.backgroundTasks.submissions).toHaveLength(1);
      expect(h.messageRepository.markProgressNotified).toHaveBeenCalledTimes(1);
      expect(h.log.debug).toHaveBeenCalledWith(
        "progress_keepalive.step_finish",
        expect.objectContaining({ skip_reason: "throttled" })
      );

      // The throttled text is still new once the gap has elapsed.
      h.keepalive.onStepFinish(
        "msg-linear",
        "tool-calls",
        STARTED_AT + 20_000 + PROGRESS_TEXT_UPDATE_MIN_GAP_MS
      );
      expect(h.backgroundTasks.submissions).toHaveLength(2);
    });
  });
});
