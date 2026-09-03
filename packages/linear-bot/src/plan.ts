/**
 * Agent plan step types and factory used by both the webhook handler and callbacks.
 */

import type { LinearApiClient } from "./utils/linear-client";
import { updateAgentSession } from "./utils/linear-client";

type PlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

export type PlanStage = "start" | "repo_resolved" | "session_created" | "completed" | "failed";

export interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

const PLAN_STEPS = [
  "Analyze issue",
  "Resolve repository",
  "Create coding session",
  "Code changes",
  "Open PR",
] as const;

const PLAN_STATUS_BY_STAGE: Record<PlanStage, PlanStepStatus[]> = {
  start: ["inProgress", "inProgress", "pending", "pending", "pending"],
  repo_resolved: ["completed", "completed", "inProgress", "pending", "pending"],
  session_created: ["completed", "completed", "completed", "inProgress", "pending"],
  completed: ["completed", "completed", "completed", "completed", "completed"],
  failed: ["completed", "completed", "completed", "completed", "canceled"],
};

export function makePlan(stage: PlanStage): PlanStep[] {
  const statuses = PLAN_STATUS_BY_STAGE[stage];
  return PLAN_STEPS.map((content, i) => ({ content, status: statuses[i] }));
}

/**
 * The plan for a flow that was stopped or failed while at `stage`: every step
 * that had not completed becomes `canceled`, so Linear stops showing work in
 * progress that will never finish.
 */
export function cancelPlanFrom(stage: PlanStage): PlanStep[] {
  return makePlan(stage).map((step) =>
    step.status === "completed" ? step : { ...step, status: "canceled" }
  );
}

/**
 * Mutable per-flow record of the last plan stage written to Linear, so an
 * error path knows which steps to cancel (and whether a plan was written at all).
 */
export interface PlanTracker {
  stage: PlanStage;
  planSet: boolean;
}

export function createPlanTracker(): PlanTracker {
  return { stage: "start", planSet: false };
}

/** Write the plan for `stage` to Linear and record it on the tracker. */
export async function setPlan(
  client: LinearApiClient,
  agentSessionId: string,
  tracker: PlanTracker,
  stage: PlanStage
): Promise<void> {
  await updateAgentSession(client, agentSessionId, { plan: makePlan(stage) });
  tracker.stage = stage;
  tracker.planSet = true;
}
