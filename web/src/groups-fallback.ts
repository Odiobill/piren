/**
 * SR-3: the fallback candidate staging decision as a pure core so duplicate
 * and self rejection stay directly testable and the panel cannot silently
 * discard a visible selection.
 */

import { agentDisplayName } from "./agent-display.js";

export type FallbackStageOutcome =
  | { kind: "staged"; candidates: string[] }
  | { kind: "rejected"; reason: string };

/**
 * Decide what choosing `choice` means for the staged ordered candidate list
 * of `member`. A fresh valid candidate is appended immediately (exact order
 * preserved); the target itself and already-staged candidates are rejected
 * with an exact bounded reason instead of being silently dropped.
 */
export function stageFallbackCandidate(candidates: string[], member: string, choice: string): FallbackStageOutcome {
  if (choice === "") return { kind: "rejected", reason: "Choose a candidate first." };
  if (choice === member) return { kind: "rejected", reason: `${agentDisplayName(member)} cannot be its own fallback.` };
  if (candidates.includes(choice)) {
    return { kind: "rejected", reason: `${agentDisplayName(choice)} is already in the ordered list.` };
  }
  return { kind: "staged", candidates: [...candidates, choice] };
}
