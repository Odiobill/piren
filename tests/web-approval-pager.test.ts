import { describe, expect, it } from "vitest";
import {
  approvalSelectionForIndex,
  nextApprovalSelection,
} from "../web/src/conversation-approval-pager.js";

/**
 * ADR-0044 Tracer B correction — pure approval-pager selection core. The tray
 * renders exactly ONE selected pending approval card; every pending approval
 * stays in memory and is reachable through the pager. Selection transitions
 * are deterministic: a new arrival becomes selected (focus-on-arrival);
 * manual navigation keeps focus on the pager (no card auto-focus); an
 * answered card is replaced by the deterministic clamped remaining card.
 */

function approvals(...ids: string[]): Array<{ requestId: string }> {
  return ids.map((requestId) => ({ requestId }));
}

describe("nextApprovalSelection (pure)", () => {
  it("returns null when no approvals are pending", () => {
    expect(nextApprovalSelection({ approvals: [], previousIds: [], selectedId: null })).toBeNull();
  });

  it("selects the first arrival with card focus (focus-on-arrival)", () => {
    const decision = nextApprovalSelection({ approvals: approvals("r1"), previousIds: [], selectedId: null });
    expect(decision).toEqual({ selectedId: "r1", focusCard: true });
  });

  it("selects the newest arrival with card focus while an older card is selected", () => {
    const decision = nextApprovalSelection({
      approvals: approvals("r1", "r2", "r3"),
      previousIds: ["r1", "r2"],
      selectedId: "r1",
    });
    expect(decision).toEqual({ selectedId: "r3", focusCard: true });
  });

  it("selects the last of a batched arrival group deterministically", () => {
    const decision = nextApprovalSelection({
      approvals: approvals("r1", "r2", "r3"),
      previousIds: [],
      selectedId: null,
    });
    expect(decision).toEqual({ selectedId: "r3", focusCard: true });
  });

  it("keeps the current selection without card focus when nothing arrived or left", () => {
    const decision = nextApprovalSelection({
      approvals: approvals("r1", "r2"),
      previousIds: ["r1", "r2"],
      selectedId: "r2",
    });
    expect(decision).toEqual({ selectedId: "r2", focusCard: false });
  });

  it("keeps the current selection when a different card leaves", () => {
    const decision = nextApprovalSelection({
      approvals: approvals("r2"),
      previousIds: ["r1", "r2"],
      selectedId: "r2",
    });
    expect(decision).toEqual({ selectedId: "r2", focusCard: false });
  });

  it("after the selected card is answered, selects the deterministic clamped remaining card with card focus", () => {
    // Answered r2 of [r1, r2, r3]: the card at the same index (r3) remains.
    const decision = nextApprovalSelection({
      approvals: approvals("r1", "r3"),
      previousIds: ["r1", "r2", "r3"],
      selectedId: "r2",
    });
    expect(decision).toEqual({ selectedId: "r3", focusCard: true });
  });

  it("after the LAST selected card is answered, clamps to the new last card", () => {
    const decision = nextApprovalSelection({
      approvals: approvals("r1", "r2"),
      previousIds: ["r1", "r2", "r3"],
      selectedId: "r3",
    });
    expect(decision).toEqual({ selectedId: "r2", focusCard: true });
  });
});

describe("approvalSelectionForIndex (pure manual navigation)", () => {
  it("selects the indexed card without card focus (focus stays on the pager)", () => {
    expect(approvalSelectionForIndex(approvals("r1", "r2", "r3"), 1)).toEqual({ selectedId: "r2", focusCard: false });
  });

  it("rejects out-of-range indexes (never fabricates a selection)", () => {
    expect(approvalSelectionForIndex(approvals("r1"), -1)).toBeNull();
    expect(approvalSelectionForIndex(approvals("r1"), 1)).toBeNull();
    expect(approvalSelectionForIndex([], 0)).toBeNull();
  });
});
