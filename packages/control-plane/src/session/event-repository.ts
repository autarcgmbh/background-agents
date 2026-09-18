import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  MAX_LINEAR_PROGRESS_TEXT_CHARS,
  type LinearProgressPhase,
} from "@open-inspect/shared/types/session-api";
import {
  EMPTY_MODEL_TOKEN_USAGE,
  UNATTRIBUTED_MODEL_ID,
  totalTokens,
  type ModelTokenUsage,
} from "@open-inspect/shared/model-pricing";
import {
  eventTimelineCursorFromRow,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import type { EventRow } from "./types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type UpsertableEventType = TokenEvent["type"] | ExecutionCompleteEvent["type"];

const NEXT_TIMELINE_SEQUENCE_SQL = "(SELECT COALESCE(MAX(timeline_sequence), 0) + 1 FROM events)";

/**
 * Data for creating an event. Type is open because sandboxes emit additional
 * event types beyond the shared EventType union.
 */
export interface CreateEventData {
  id: string;
  type: string;
  data: string;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventPageOptions {
  cursor?: EventListCursor | null;
  limit: number;
  type?: string | null;
  messageId?: string | null;
}

export interface ListEventTimelinePageOptions {
  cursor?: EventTimelineCursor | null;
  excludeTypes?: string[];
  limit: number;
}

export interface EventPage {
  events: EventRow[];
  hasMore: boolean;
  nextCursor: EventTimelineCursor | null;
}

interface QueryEventPageOptions extends ListEventPageOptions {
  excludeTypes?: string[];
}

/** What a running message looks like right now, for Linear progress callbacks. */
export interface MessageProgressSnapshot {
  toolCallCount: number;
  currentTool?: { tool: string; callId: string; status?: string };
  phase: LinearProgressPhase;
  /** Tail of the latest assistant text, capped at MAX_LINEAR_PROGRESS_TEXT_CHARS. */
  latestText?: string;
}

const ACTIVE_TOOL_CALL_STATUSES = new Set(["pending", "running"]);

function parseEventData(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Persistence for events scoped to one session. */
export class EventRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  createEvent(data: CreateEventData): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt
    );
  }

  recordStepUsage(event: Extract<SandboxEvent, { type: "step_finish" }>, now: number): void {
    // Without a stable part ID, repeated updates cannot be distinguished from
    // new steps. Leave older runtimes unreported rather than inflate their usage.
    if (!event.stepId || reportedTokenComponents(event.tokens) === null) return;
    const id = `step_finish:${JSON.stringify([event.messageId, event.childSessionId ?? "", event.stepId])}`;
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, 'step_finish', ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      id,
      JSON.stringify(event),
      event.messageId,
      now
    );
  }

  /** Null means no token usage was reported, which is different from zero. */
  getTotalTokens(): number | null {
    const usage = this.getUsageByModel();
    return usage ? usage.reduce((sum, entry) => sum + totalTokens(entry.usage), 0) : null;
  }

  /**
   * Reported usage split by the model that spent it, for cost attribution.
   * Null when nothing was reported, which is different from an empty split.
   *
   * Steps whose model the runtime did not name are pooled under
   * `UNATTRIBUTED_MODEL_ID`, so their tokens still count toward the session
   * total but are never priced.
   */
  getUsageByModel(): Array<{ modelId: string; usage: ModelTokenUsage }> | null {
    const rows = this.sql
      .exec("SELECT data FROM events WHERE type = 'step_finish'")
      .toArray() as Array<{ data: string }>;
    const byModel = new Map<string, ModelTokenUsage>();
    let reported = false;
    for (const row of rows) {
      const event = parseEventData(row.data);
      const components = reportedTokenComponents(event?.tokens);
      if (!components) continue;
      reported = true;
      const modelId =
        typeof event?.model === "string" && event.model ? event.model : UNATTRIBUTED_MODEL_ID;
      const current = byModel.get(modelId) ?? { ...EMPTY_MODEL_TOKEN_USAGE };
      current.input += components.input;
      current.output += components.output;
      current.cacheRead += components.cacheRead;
      current.cacheWrite += components.cacheWrite;
      current.reasoning += components.reasoning;
      byModel.set(modelId, current);
    }
    if (!reported) return null;
    return [...byModel].map(([modelId, usage]) => ({ modelId, usage }));
  }

  createContextCompactionEvent(data: CreateEventData & { messageId: string }): void {
    this.transactionSync(() => {
      this.sql.exec(
        `UPDATE events SET id = ? WHERE id = ?`,
        `token:${data.messageId}:${data.id}`,
        `token:${data.messageId}`
      );
      this.createEvent(data);
    });
  }

  private upsertEventByMessageId<TType extends UpsertableEventType>(
    type: TType,
    messageId: string,
    event: Extract<SandboxEvent, { type: TType }>,
    createdAt: number
  ): void {
    const id = `${type}:${messageId}`;
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id,
         created_at = excluded.created_at`,
      id,
      type,
      JSON.stringify(event),
      messageId,
      createdAt
    );
  }

  upsertTokenEvent(messageId: string, event: TokenEvent, createdAt: number): void {
    this.upsertEventByMessageId("token", messageId, event, createdAt);
  }

  upsertToolCallEvent(messageId: string, event: ToolCallEvent, createdAt: number): void {
    const id = `tool_call:${toolCallIdentityKey(event)}`;
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id`,
      id,
      event.type,
      JSON.stringify(event),
      messageId,
      createdAt
    );
  }

  upsertExecutionCompleteEvent(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.upsertEventByMessageId("execution_complete", messageId, event, createdAt);
  }

  /**
   * Phase heuristic: an unfinished tool call wins; otherwise text that arrived
   * after the newest tool call means the model is responding; otherwise it is
   * still thinking. Tool-call rows keep their first-seen `created_at`, and the
   * token row is re-stamped on every upsert, so the comparison is between the
   * newest tool start and the latest text activity.
   */
  getMessageProgressSnapshot(messageId: string): MessageProgressSnapshot {
    const toolCalls = this.sql
      .exec(
        `SELECT data, created_at FROM events
         WHERE type = 'tool_call' AND message_id = ?
         ORDER BY created_at DESC, timeline_sequence DESC`,
        messageId
      )
      .toArray() as Array<{ data: string; created_at: number }>;
    const tokenRow = (
      this.sql
        .exec(`SELECT data, created_at FROM events WHERE id = ?`, `token:${messageId}`)
        .toArray() as Array<{ data: string; created_at: number }>
    )[0];

    const parsedToolCalls = toolCalls.map((row) => ({
      createdAt: row.created_at,
      event: parseEventData(row.data),
    }));
    const activeToolCall = parsedToolCalls.find(
      ({ event }) =>
        typeof event?.status === "string" && ACTIVE_TOOL_CALL_STATUSES.has(event.status)
    );
    const tokenContent = parseEventData(tokenRow?.data ?? "")?.content;
    const text = typeof tokenContent === "string" ? tokenContent : "";
    const latestText = text.length > 0 ? text.slice(-MAX_LINEAR_PROGRESS_TEXT_CHARS) : undefined;

    let phase: LinearProgressPhase = "thinking";
    if (activeToolCall) {
      phase = "tool_call";
    } else if (
      tokenRow &&
      latestText !== undefined &&
      (parsedToolCalls.length === 0 || tokenRow.created_at > parsedToolCalls[0].createdAt)
    ) {
      phase = "responding";
    }

    const activeEvent = activeToolCall?.event;
    const currentTool =
      activeEvent && typeof activeEvent.tool === "string" && typeof activeEvent.callId === "string"
        ? {
            tool: activeEvent.tool,
            callId: activeEvent.callId,
            ...(typeof activeEvent.status === "string" ? { status: activeEvent.status } : {}),
          }
        : undefined;

    return {
      toolCallCount: toolCalls.length,
      ...(currentTool ? { currentTool } : {}),
      phase,
      ...(latestText !== undefined ? { latestText } : {}),
    };
  }

  listEventPage(options: ListEventPageOptions): EventPage {
    return this.queryEventPage(options);
  }

  getEventTimelinePage(options: ListEventTimelinePageOptions): EventPage {
    const page = this.queryEventPage(options);
    return { ...page, events: [...page.events].reverse() };
  }

  private queryEventPage(options: QueryEventPageOptions): EventPage {
    let query = `SELECT * FROM events`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push(`type = ?`);
      params.push(options.type);
    }
    if (options.messageId) {
      conditions.push(`message_id = ?`);
      params.push(options.messageId);
    }
    if (options.excludeTypes?.length) {
      conditions.push(`type NOT IN (${options.excludeTypes.map(() => "?").join(", ")})`);
      params.push(...options.excludeTypes);
    }

    const cursor = options.cursor;
    if (cursor?.kind === "timeline") {
      if (cursor.sequence !== undefined) {
        conditions.push(`((created_at < ?) OR (created_at = ? AND timeline_sequence < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.sequence);
      } else {
        conditions.push(`((created_at < ?) OR (created_at = ? AND id < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    } else if (cursor?.kind === "legacy") {
      conditions.push(`created_at < ?`);
      params.push(cursor.createdAt);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(" AND ")}`;

    const tieBreaker =
      cursor?.kind === "timeline" && cursor.sequence === undefined ? "id" : "timeline_sequence";
    query += ` ORDER BY created_at DESC, ${tieBreaker} DESC LIMIT ?`;
    params.push(options.limit + 1);

    const rows = this.sql.exec(query, ...params).toArray() as EventRow[];
    const hasMore = rows.length > options.limit;
    const events = hasMore ? rows.slice(0, options.limit) : rows;
    const nextCursor = events.length ? eventTimelineCursorFromRow(events[events.length - 1]) : null;
    return { events, hasMore, nextCursor };
  }
}

/**
 * Split one reported usage into billable components, or null when the runtime
 * reported nothing usable.
 *
 * A runtime that reports only a bare total (or a `total` field) gives no way to
 * tell input from output, which price an order of magnitude apart. Such a total
 * is carried in `input` purely so the token count stays right: it only reaches
 * a price if its model is priced, and a step that vague never names one, so it
 * lands in the unattributed bucket and is excluded from cost either way.
 */
function reportedTokenComponents(usage: unknown): ModelTokenUsage | null {
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const count = (value: unknown): number => (valid(value) ? value : 0);
  if (valid(usage)) return { ...EMPTY_MODEL_TOKEN_USAGE, input: usage };
  if (typeof usage !== "object" || usage === null) return null;
  const details = usage as Record<string, unknown>;
  const cache = details.cache as Record<string, unknown> | undefined;
  // OpenCode reports uncached input, output, reasoning, and cache separately.
  const components: ModelTokenUsage = {
    input: count(details.input),
    output: count(details.output),
    reasoning: count(details.reasoning),
    cacheRead: count(cache?.read),
    cacheWrite: count(cache?.write),
  };
  if (
    valid(details.input) ||
    valid(details.output) ||
    valid(details.reasoning) ||
    valid(cache?.read) ||
    valid(cache?.write)
  ) {
    return components;
  }
  if (valid(details.total)) return { ...EMPTY_MODEL_TOKEN_USAGE, input: details.total };
  return null;
}
