// W5a — pure associated-workflow budget view. The popup must receive only the
// complete, gateway-resolved exact-pair snapshot; it never selects a root from
// a Conversation-wide list or derives one from telemetry/activity.

import { describe, expect, it } from "vitest";
import {
  associatedWorkflowBudgetView,
  buildAssociatedWorkflowBudgetUpdateRequest,
} from "../web/src/conversation-associated-workflow-budget.js";
import type { ConversationWorkflowStatusSnapshot } from "../web/src/api.js";

const ASSOCIATED: ConversationWorkflowStatusSnapshot = {
  runActive: true,
  workflow: {
    rootEventId: "root-1",
    association: "active-run",
    base: { edges: 8, reworkRounds: 2 },
    effective: { edges: 10, reworkRounds: 3 },
    consumed: { edges: 8 },
    worstPairOccurrences: 3,
    low: true,
    exhausted: false,
    warnings: ["one ignored update"],
    omittedWarnings: 2,
  },
};

describe("W5a associated workflow budget view", () => {
  it("retains the complete gateway-resolved root facts for one agent, without a browser-selected root", () => {
    expect(associatedWorkflowBudgetView(ASSOCIATED)).toEqual({
      rootEventId: "root-1",
      association: "active-run",
      base: { edges: 8, reworkRounds: 2 },
      effective: { edges: 10, reworkRounds: 3 },
      consumed: { edges: 8 },
      worstPairOccurrences: 3,
      low: true,
      exhausted: false,
      warnings: ["one ignored update"],
      omittedWarnings: 2,
    });
  });

  it("returns no budget capability for a busy non-C5 run with no associated workflow", () => {
    expect(associatedWorkflowBudgetView({ runActive: true, workflow: null })).toBeNull();
  });

  it("builds the existing closed CAS request from only the associated snapshot and changed draft", () => {
    expect(
      buildAssociatedWorkflowBudgetUpdateRequest({
        snapshot: ASSOCIATED,
        draft: { edges: "12", reworkRounds: "" },
        busy: false,
      }),
    ).toEqual({
      root_event_id: "root-1",
      edges: 12,
      expected_effective: { edges: 10, reworkRounds: 3 },
    });
  });

  it("refuses to make a request for a null association or an unchanged draft", () => {
    expect(
      buildAssociatedWorkflowBudgetUpdateRequest({
        snapshot: { runActive: false, workflow: null },
        draft: { edges: "12", reworkRounds: "" },
        busy: false,
      }),
    ).toBeNull();
    expect(
      buildAssociatedWorkflowBudgetUpdateRequest({
        snapshot: ASSOCIATED,
        draft: { edges: "10", reworkRounds: "3" },
        busy: false,
      }),
    ).toBeNull();
  });
});
