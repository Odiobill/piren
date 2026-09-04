import type { ConversationWorkflowStatusSnapshot } from "./api";
import {
  buildWorkflowBudgetUpdateRequest,
  type WorkflowBudgetDraft,
  type WorkflowBudgetDimensionView,
  type WorkflowBudgetUpdateRequest,
} from "./conversation-workflow-budget";

/**
 * W5a — one exact agent's gateway-resolved associated workflow-root budget.
 * This is a pure projection: it accepts no Conversation-wide root list and
 * therefore cannot let the browser select or fabricate a root.
 */
export interface AssociatedWorkflowBudgetView {
  rootEventId: string;
  association: "active-run" | "latest-run";
  base: WorkflowBudgetDimensionView;
  effective: WorkflowBudgetDimensionView;
  consumed: { edges: number };
  worstPairOccurrences: number;
  low: boolean;
  exhausted: boolean;
  warnings: string[];
  omittedWarnings: number;
}

/** Return the complete associated-root view, or no budget capability. */
export function associatedWorkflowBudgetView(snapshot: ConversationWorkflowStatusSnapshot): AssociatedWorkflowBudgetView | null {
  const workflow = snapshot.workflow;
  if (workflow === null) return null;
  return {
    rootEventId: workflow.rootEventId,
    association: workflow.association,
    base: { ...workflow.base },
    effective: { ...workflow.effective },
    consumed: { ...workflow.consumed },
    worstPairOccurrences: workflow.worstPairOccurrences,
    low: workflow.low,
    exhausted: workflow.exhausted,
    warnings: [...workflow.warnings],
    omittedWarnings: workflow.omittedWarnings,
  };
}

/**
 * Build the existing closed budget-update CAS request from only the exact
 * status association. A null association has no root and cannot mutate one.
 */
export function buildAssociatedWorkflowBudgetUpdateRequest(input: {
  snapshot: ConversationWorkflowStatusSnapshot;
  draft: WorkflowBudgetDraft;
  busy: boolean;
}): WorkflowBudgetUpdateRequest | null {
  const workflow = associatedWorkflowBudgetView(input.snapshot);
  if (workflow === null) return null;
  return buildWorkflowBudgetUpdateRequest({
    rootEventId: workflow.rootEventId,
    draft: input.draft,
    effective: workflow.effective,
    busy: input.busy,
  });
}
