import { z } from "zod";
import { linearGraphQL, type LinearApiClient } from "./linear-client";
import { createLogger } from "../logger";

const log = createLogger("issue-delegate");

const delegateMutationSchema = z.object({
  data: z.object({
    issueUpdate: z.object({ success: z.literal(true) }),
  }),
});

export type IssueDelegateResult =
  | { outcome: "set" }
  | { outcome: "already_self" }
  | { outcome: "delegated_to_other"; delegateId: string }
  | { outcome: "failed" };

/**
 * Make the agent the issue's delegate when nobody else is, per Linear's
 * agent best practices: a human keeps the assignment, the agent is visibly
 * the one doing the implementation work. Best-effort; never throws.
 */
export async function ensureSelfDelegate(
  client: LinearApiClient,
  params: { issueId: string; appUserId: string; currentDelegateId: string | null | undefined },
  signal?: AbortSignal
): Promise<IssueDelegateResult> {
  const { issueId, appUserId, currentDelegateId } = params;
  if (currentDelegateId === appUserId) return { outcome: "already_self" };
  if (currentDelegateId) return { outcome: "delegated_to_other", delegateId: currentDelegateId };

  try {
    delegateMutationSchema.parse(
      await linearGraphQL(
        client,
        `
      mutation IssueSetDelegate($issueId: String!, $delegateId: String!) {
        issueUpdate(id: $issueId, input: { delegateId: $delegateId }) {
          success
        }
      }
    `,
        { issueId, delegateId: appUserId },
        signal
      )
    );
    return { outcome: "set" };
  } catch (err) {
    log.warn("linear.set_delegate_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { outcome: "failed" };
  }
}
