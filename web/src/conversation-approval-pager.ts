/**
 * ADR-0044 Tracer B correction — pure approval-pager selection core.
 *
 * The interaction tray renders exactly ONE selected pending approval card;
 * every pending approval received by the scoped SSE path remains in memory
 * and is reachable through the accessible Previous/Next pager. Selection
 * transitions are deterministic and presentation-only:
 *
 * - a newly received approval becomes selected and its card keeps the
 *   existing focus-on-arrival behavior (`focusCard: true`);
 * - an unchanged or non-selected removal keeps the current selection with no
 *   card focus change;
 * - an answered (removed) selected card is replaced by the deterministic
 *   remaining card at the clamped previous index, focused like an arrival so
 *   the keyboard steward lands on a real control;
 * - manual pager navigation selects the indexed card with `focusCard: false`
 *   so focus stays on the invoked pager button (no focus theft).
 *
 * No approval is dropped, auto-responded, persisted, inferred, or reordered
 * as a gateway fact: this module only picks which already-pending card is
 * visible. This module is DOM-free and framework-free.
 */

export interface ApprovalPagerItem {
  requestId: string;
}

export interface ApprovalPagerSelection {
  selectedId: string;
  /** True only when the newly selected card may auto-focus (arrival or post-answer replacement). */
  focusCard: boolean;
}

/**
 * Resolve the selected card after the pending-approval list changed.
 * `previousIds` is the id list seen before this update (arrival order).
 */
export function nextApprovalSelection(args: {
  approvals: readonly ApprovalPagerItem[];
  previousIds: readonly string[];
  selectedId: string | null;
}): ApprovalPagerSelection | null {
  const { approvals, previousIds, selectedId } = args;
  if (approvals.length === 0) return null;
  const previous = new Set(previousIds);
  const fresh = approvals.filter((approval) => !previous.has(approval.requestId));
  if (fresh.length > 0) {
    // Arrival: select the newest new approval (deterministic for batches).
    return { selectedId: (fresh[fresh.length - 1] as ApprovalPagerItem).requestId, focusCard: true };
  }
  if (selectedId !== null && approvals.some((approval) => approval.requestId === selectedId)) {
    // Unchanged (or a non-selected removal): keep the current card.
    return { selectedId, focusCard: false };
  }
  // The selected card was answered: select the deterministic remaining card
  // at the clamped previous index.
  const previousIndex = selectedId === null ? -1 : previousIds.indexOf(selectedId);
  const clamped = Math.min(Math.max(previousIndex, 0), approvals.length - 1);
  const target = approvals[clamped];
  if (target === undefined) return null;
  return { selectedId: target.requestId, focusCard: true };
}

/**
 * Manual pager navigation: select the indexed already-pending card with no
 * card auto-focus (the invoked pager button keeps focus). Out-of-range
 * indexes return null and never fabricate a selection.
 */
export function approvalSelectionForIndex(
  approvals: readonly ApprovalPagerItem[],
  index: number,
): ApprovalPagerSelection | null {
  if (index < 0 || index >= approvals.length) return null;
  const target = approvals[index];
  if (target === undefined) return null;
  return { selectedId: target.requestId, focusCard: false };
}
