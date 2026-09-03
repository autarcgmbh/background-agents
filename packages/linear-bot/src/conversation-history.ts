/**
 * Conversation reconstruction from Agent Activities.
 *
 * Linear's guidance: comments are editable, activities are frozen snapshots,
 * so rebuild what was said from the agent session's activities. Only the
 * user-visible turns matter for the coding agent — prompts, responses,
 * errors and elicitations; thoughts, tool actions and ephemeral rows are
 * noise.
 */

import type { AgentSessionActivity } from "./utils/linear-client";

export type ConversationTurnKind = "prompt" | "response" | "error" | "elicitation";

export interface ConversationTurn {
  kind: ConversationTurnKind;
  body: string;
}

export const HISTORY_MAX_TURNS = 12;
export const HISTORY_MAX_CHARS = 4000;
export const HISTORY_TURN_MAX_CHARS = 800;

const TURN_KINDS = new Set<string>(["prompt", "response", "error", "elicitation"]);

function truncateTurn(body: string): string {
  return body.length > HISTORY_TURN_MAX_CHARS
    ? `${body.slice(0, HISTORY_TURN_MAX_CHARS - 1)}…`
    : body;
}

/**
 * Pick the turns worth replaying, newest first while trimming to the caps,
 * returned oldest first. `excludeLatestPromptBody` removes the prompt that
 * triggered the current webhook so it is not echoed as history.
 */
export function selectConversationHistory(
  activities: AgentSessionActivity[],
  options: { excludeLatestPromptBody?: string } = {}
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const activity of activities) {
    if (activity.ephemeral) continue;
    if (!TURN_KINDS.has(activity.kind)) continue;
    if (activity.kind === "prompt" && activity.signal === "stop") continue;
    const body = activity.body.trim();
    if (!body) continue;
    turns.push({ kind: activity.kind as ConversationTurnKind, body });
  }

  const exclude = options.excludeLatestPromptBody?.trim();
  if (exclude) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].kind === "prompt" && turns[i].body === exclude) {
        turns.splice(i, 1);
        break;
      }
    }
  }

  const selected: ConversationTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const body = truncateTurn(turns[i].body);
    if (selected.length >= HISTORY_MAX_TURNS) break;
    if (selected.length > 0 && chars + body.length > HISTORY_MAX_CHARS) break;
    selected.push({ kind: turns[i].kind, body });
    chars += body.length;
  }
  return selected.reverse();
}

/** True when the history already carries an agent turn (a response or error). */
export function historyHasAgentTurn(history: ConversationTurn[]): boolean {
  return history.some((turn) => turn.kind === "response" || turn.kind === "error");
}
