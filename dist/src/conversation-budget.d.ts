import type { ConversationEventRecord } from "./conversations.js";
/** Fixed hard cap for the adjustable per-root edges budget (contract §2.2). */
export declare const HANDOFF_BUDGET_MAX_EDGES = 24;
/** Fixed hard cap for the adjustable per-root rework-rounds budget (contract §2.2). */
export declare const HANDOFF_BUDGET_MAX_REWORK_ROUNDS = 6;
/** The closed adjustable budget dimensions (contract §2.1; depth stays fixed). */
export interface HandoffBudgetValue {
    edges: number;
    reworkRounds: number;
}
/** The C5-aligned base budget; the existing C5 constants are reused unchanged. */
export declare function handoffBudgetBase(): HandoffBudgetValue;
/**
 * Pure injected evidence representation for one durable budget-update record
 * (contract §3.2). B2 will map the future `handoff_budget_updated` event
 * records onto this seam; B1 never touches production Conversation types.
 * `kind`/`authorKind` are plain strings so wrong shapes remain expressible
 * (and testable) — shape validity is enforced by the derivation below.
 */
export interface HandoffBudgetUpdateEvidence {
    /** Durable evidence id (future event id); must be a non-empty string. */
    eventId: string;
    /** Durable sequence number; updates apply in ascending order (stable). */
    sequence: number;
    /** Must be exactly the budget-update kind. */
    kind: string;
    /** Must be exactly the durable steward author identity. */
    author: string;
    /** Must be exactly the steward author kind: only stewards raise budgets. */
    authorKind: string;
    /** The deriving workflow root this update claims to target. */
    rootEventId: string;
    /** Must equal `rootEventId` (the update is correlated to the exact root). */
    correlationId: string;
    /** Optional edges raise: `from` must equal the prior effective edges value.
     *  Values are `unknown` so hand-edited durable garbage survives into the
     *  fail-closed validation instead of being dropped by a narrower type. */
    edges?: {
        from: unknown;
        to: unknown;
    } | undefined;
    /** Optional rework raise: `from` must equal the prior effective rework value. */
    reworkRounds?: {
        from: unknown;
        to: unknown;
    } | undefined;
}
/** Injected workflow usage facts (later supplied by the C5 workflow derivation). */
export interface HandoffBudgetUsage {
    /** Accepted handoff edges for this workflow root. */
    consumedEdges: number;
    /** Max occurrence count over all source->target pairs of this root. */
    worstPairOccurrences: number;
}
/** Bounded, inspectable, non-secret metadata for one ignored evidence update. */
export interface IgnoredHandoffBudgetUpdate {
    /** The provided eventId, or a deterministic placeholder when unusable. */
    eventId: string;
    /** The provided sequence when it is a positive integer; null otherwise. */
    sequence: number | null;
    /** Deterministic, bounded, non-secret reason. Never echoes values. */
    reason: string;
}
/** Derived per-root budget facts sufficient for the later layers (contract §3.2). */
export interface DerivedHandoffBudget {
    rootEventId: string;
    /** The fixed C5 base; never changed by updates. */
    base: HandoffBudgetValue;
    /** The chain-validated effective budget; never lowered by any update. */
    effective: HandoffBudgetValue;
    /** Accepted handoff edges consumed by this workflow root (injected usage). */
    consumedEdges: number;
    /** effective.edges - consumedEdges (cannot go negative in valid states). */
    remainingEdges: number;
    /** Max occurrence count over pairs (injected usage). */
    worstPairOccurrences: number;
    /** (1 + effective.reworkRounds) - worstPairOccurrences for the worst pair. */
    remainingReworkRounds: number;
    /** Evidence ids that applied, in durable sequence order. */
    validUpdateEventIds: string[];
    /** Ignored evidence updates with bounded non-secret reasons. */
    ignored: IgnoredHandoffBudgetUpdate[];
    /** Red semantics (contract §2.4/§6): the edges budget is fully consumed. */
    exhausted: boolean;
    /** Yellow semantics (contract §2.4): remaining edges <= 2 OR remaining rework <= 1.
     * Computed independently of `exhausted`; UI precedence (red > yellow) masks it. */
    low: boolean;
}
/**
 * Validate one update candidate (a route-level steward request, §2.2)
 * against the current effective values. Deterministic non-secret rejection
 * reasons; no clamping — an out-of-cap or non-raising candidate is rejected,
 * never silently adjusted.
 */
export type HandoffBudgetCandidateValidation = {
    ok: true;
    edges?: number;
    reworkRounds?: number;
} | {
    ok: false;
    reason: string;
};
export declare function validateHandoffBudgetUpdateCandidate(input: {
    candidate: {
        edges?: unknown;
        reworkRounds?: unknown;
    };
    current: HandoffBudgetValue;
}): HandoffBudgetCandidateValidation;
/**
 * B2 adapter: map one parsed durable `handoff_budget_updated`
 * `ConversationEventRecord` onto the B1 pure evidence seam. Pure and total:
 * the record's `correlationId` is carried verbatim (a missing/mismatched
 * correlation fail-closes in the B1 derivation against `rootEventId`), and
 * the raw dimension payload (including hand-edited value-level garbage) is
 * passed through unchanged so the B1 derivation — never this adapter —
 * decides validity. `deriveConversationWorkflowState` is untouched; B3
 * alone wires planner/broker consumption.
 */
export declare function handoffBudgetEvidenceFromRecord(record: ConversationEventRecord, rootEventId: string): HandoffBudgetUpdateEvidence;
/**
 * Derive the per-root effective budget from injected update evidence and
 * injected usage facts (contract §3.2). Updates apply in a TOTAL
 * deterministic order: ascending valid durable sequence as the primary key,
 * then a bounded identity-based tie-break (eventId), then a canonical
 * record-serialization comparison as the final tie policy — so the entire
 * derived result, including the ordered `ignored` metadata, is identical
 * regardless of caller array order, even for equal/malformed/duplicate
 * sequence evidence. A whole update is ignored — never applied partially —
 * when its shape is invalid, any mentioned dimension fails its chain
 * validation, or it mentions no dimension. Ignored updates are recorded
 * with bounded non-secret reasons; the effective budget is never widened or
 * lowered by them. Duplicate durable identity/order is whole-GROUP rejected
 * BEFORE any chain application (a durable event id or sequence position
 * identifies exactly one record); separately, a replay under a distinct id
 * whose `from` no longer matches the advanced effective value fails the
 * chain rule and is ignored — the budget applies exactly once.
 */
export declare function deriveHandoffBudget(input: {
    rootEventId: string;
    updates: readonly HandoffBudgetUpdateEvidence[];
    usage: HandoffBudgetUsage;
}): DerivedHandoffBudget;
