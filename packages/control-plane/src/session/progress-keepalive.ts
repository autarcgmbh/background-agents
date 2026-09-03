/**
 * Linear progress keepalive.
 *
 * Linear marks an agent session stale after 30 minutes without agent activity.
 * While a Linear-sourced message is processing, this emits a `heartbeat`
 * progress callback at a fixed interval (anchored on the last progress
 * callback of any kind) and a `step_finish` progress callback whenever a new
 * assistant text segment completes. It shares the Durable Object's single
 * alarm slot through the earliest-deadline scheduler and re-asserts its own
 * deadline on every tick, like the execution-timeout watchdog.
 */

import type { LinearProgressTrigger } from "@open-inspect/shared/types/session-api";
import type { Logger } from "../logger";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import type { EventRepository } from "./event-repository";
import type { MessageRepository, ProcessingProgressCandidate } from "./message-repository";

export const PROGRESS_KEEPALIVE_INTERVAL_MS = 5 * 60_000;
/** An alarm that fires this close to the deadline counts as due; the scheduler is not re-armed for the remainder. */
export const PROGRESS_KEEPALIVE_TOLERANCE_MS = 5_000;
/** Minimum spacing between `step_finish` progress callbacks per session. */
export const PROGRESS_TEXT_UPDATE_MIN_GAP_MS = 10_000;

export interface ProgressKeepalive {
  /** Arm the first heartbeat right after a prompt is dispatched to the sandbox. */
  armForDispatch(messageId: string, dispatchedAt: number): Promise<void>;
  /** Alarm entry point: deliver a heartbeat when due, otherwise re-assert the deadline. */
  tick(): Promise<void>;
  /** A step finished; surface its text if it is new and not throttled. */
  onStepFinish(messageId: string, reason: string | undefined, now: number): void;
}

export interface ProgressKeepaliveDeps {
  messageRepository: Pick<
    MessageRepository,
    "getProcessingProgressCandidate" | "markProgressNotified"
  >;
  eventRepository: Pick<EventRepository, "getMessageProgressSnapshot">;
  callbackService: {
    notifyProgress(
      messageId: string,
      input: { trigger: LinearProgressTrigger; elapsedMs: number }
    ): Promise<void>;
  };
  alarmScheduler: Pick<AlarmScheduler, "schedule">;
  backgroundTasks: BackgroundTasks;
  now: () => number;
  log: Logger;
}

/** The final text of a turn arrives through `/callbacks/complete`, not as progress. */
const STEP_FINISH_REASON_STOP = "stop";

/** Mirrors `CallbackNotificationService.resolveCallbackRoute` for the linear destination. */
function isLinearCallbackMessage(
  candidate: Pick<ProcessingProgressCandidate, "source" | "callback_context">
): boolean {
  return candidate.source === "linear" && candidate.callback_context !== null;
}

/** FNV-1a; only equality between two snapshots of the same message matters. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function createProgressKeepalive(deps: ProgressKeepaliveDeps): ProgressKeepalive {
  // Messages process one at a time, so the last notified text is a single
  // (messageId, hash) pair rather than an unbounded map.
  let lastNotifiedText: { messageId: string; hash: number } | null = null;
  let lastTextUpdateAt: number | null = null;

  const submitProgress = (
    candidate: ProcessingProgressCandidate & { started_at: number },
    trigger: LinearProgressTrigger,
    now: number
  ): void => {
    // Mark before delivery so a slow or failed callback cannot re-trigger
    // the heartbeat on the very next alarm.
    deps.messageRepository.markProgressNotified(candidate.id, now);
    deps.backgroundTasks.submit(
      () =>
        deps.callbackService.notifyProgress(candidate.id, {
          trigger,
          elapsedMs: now - candidate.started_at,
        }),
      { name: "callback.notify_progress", context: { message_id: candidate.id, trigger } }
    );
  };

  const eligibleProcessingMessage = (
    messageId?: string
  ): (ProcessingProgressCandidate & { started_at: number }) | null => {
    const candidate = deps.messageRepository.getProcessingProgressCandidate();
    if (!candidate || (messageId !== undefined && candidate.id !== messageId)) return null;
    if (!isLinearCallbackMessage(candidate) || candidate.started_at === null) return null;
    if (candidate.stop_confirmation_deadline !== null) return null;
    return { ...candidate, started_at: candidate.started_at };
  };

  return {
    async armForDispatch(messageId, dispatchedAt) {
      if (!eligibleProcessingMessage(messageId)) return;
      await deps.alarmScheduler.schedule(dispatchedAt + PROGRESS_KEEPALIVE_INTERVAL_MS);
    },

    async tick() {
      const candidate = eligibleProcessingMessage();
      if (!candidate) return;

      const now = deps.now();
      const anchor = candidate.progress_notified_at ?? candidate.started_at;
      const due = anchor + PROGRESS_KEEPALIVE_INTERVAL_MS;
      if (now + PROGRESS_KEEPALIVE_TOLERANCE_MS < due) {
        // Another consumer's earlier alarm woke us; keep our own deadline armed.
        await deps.alarmScheduler.schedule(due);
        return;
      }

      submitProgress(candidate, "heartbeat", now);
      await deps.alarmScheduler.schedule(now + PROGRESS_KEEPALIVE_INTERVAL_MS);
    },

    onStepFinish(messageId, reason, now) {
      if (reason === STEP_FINISH_REASON_STOP) return;
      const candidate = eligibleProcessingMessage(messageId);
      if (!candidate) return;

      const text = deps.eventRepository.getMessageProgressSnapshot(messageId).latestText;
      if (!text) return;
      const hash = hashText(text);
      if (lastNotifiedText?.messageId === messageId && lastNotifiedText.hash === hash) {
        deps.log.debug("progress_keepalive.step_finish", {
          message_id: messageId,
          outcome: "skipped",
          skip_reason: "unchanged_text",
        });
        return;
      }
      if (lastTextUpdateAt !== null && now - lastTextUpdateAt < PROGRESS_TEXT_UPDATE_MIN_GAP_MS) {
        deps.log.debug("progress_keepalive.step_finish", {
          message_id: messageId,
          outcome: "skipped",
          skip_reason: "throttled",
        });
        return;
      }

      lastNotifiedText = { messageId, hash };
      lastTextUpdateAt = now;
      submitProgress(candidate, "step_finish", now);
    },
  };
}
