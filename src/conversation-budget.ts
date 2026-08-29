/**
 * B1 (accepted W2/W3 contract §2/§3.2) — pure, bounded Conversation
 * handoff-budget core.
 *
 * I/O-free and directly unit-testable: bases/caps are fixed constants, an
 * update candidate is validated against the current effective values, and
 * the per-root effective budget is derived from injected typed update
 * evidence plus injected workflow usage facts — never from filesystem,
 * broker, gateway, browser, or local-config state. Later layers (B2 durable
 * event mapping, B3 broker/gateway adapter, B5/B6 UI) compose with this
 * core; nothing here casts evidence into production Conversation types or
 * touches event parsing/rendering.
 *
 * Fail-closed semantics (contract §3.2): an evidence update applies per the
 * whole-event rule only when its shape is valid (root/kind/steward author/
 * correlation), each mentioned dimension's `from` equals that dimension's
 * immediately prior effective value, `to` strictly raises, and `to` is
 * within the fixed caps. Any invalid, stale, lower, duplicate, replay, or
 * malformed update is ignored with bounded inspectable warning metadata and
 * never widens or lowers the effective budget.
 */
import {
  CONVERSATION_HANDOFF_MAX_EDGES,
  CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS,
} from "./conversation-handoff.js";

/** Fixed hard cap for the adjustable per-root edges budget (contract §2.2). */
export const HANDOFF_BUDGET_MAX_EDGES = 24;

/** Fixed hard cap for the adjustable per-root rework-rounds budget (contract §2.2). */
export const HANDOFF_BUDGET_MAX_REWORK_ROUNDS = 6;

/** The closed adjustable budget dimensions (contract §2.1; depth stays fixed). */
export interface HandoffBudgetValue {
  edges: number;
  reworkRounds: number;
}

/** The C5-aligned base budget; the existing C5 constants are reused unchanged. */
export function handoffBudgetBase(): HandoffBudgetValue {
  return { edges: CONVERSATION_HANDOFF_MAX_EDGES, reworkRounds: CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS };
}

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
  /** Optional edges raise: `from` must equal the prior effective edges value. */
  edges?: { from: number; to: number } | undefined;
  /** Optional rework raise: `from` must equal the prior effective rework value. */
  reworkRounds?: { from: number; to: number } | undefined;
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

const HANDOFF_BUDGET_UPDATE_KIND = "handoff_budget_updated";
const HANDOFF_BUDGET_AUTHOR = "steward";
const HANDOFF_BUDGET_AUTHOR_KIND = "steward";
/** Contract §2.4: the low threshold for remaining edges. */
const HANDOFF_BUDGET_LOW_EDGES_REMAINING = 2;
/** Contract §2.4: the low threshold for worst-pair remaining rework rounds. */
const HANDOFF_BUDGET_LOW_REWORK_REMAINING = 1;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Validate one update candidate (a route-level steward request, §2.2)
 * against the current effective values. Deterministic non-secret rejection
 * reasons; no clamping — an out-of-cap or non-raising candidate is rejected,
 * never silently adjusted.
 */
export type HandoffBudgetCandidateValidation =
  | { ok: true; edges?: number; reworkRounds?: number }
  | { ok: false; reason: string };

export function validateHandoffBudgetUpdateCandidate(input: {
  candidate: { edges?: unknown; reworkRounds?: unknown };
  current: HandoffBudgetValue;
}): HandoffBudgetCandidateValidation {
  const { candidate, current } = input;
  const hasEdges = candidate.edges !== undefined;
  const hasRework = candidate.reworkRounds !== undefined;
  if (!hasEdges && !hasRework) {
    return { ok: false, reason: "budget update requires at least one dimension" };
  }
  let edges: number | undefined;
  let reworkRounds: number | undefined;
  if (hasEdges) {
    const value = candidate.edges;
    if (!isFiniteInteger(value) || (value as number) <= 0) {
      return { ok: false, reason: "budget edges must be a positive integer" };
    }
    if ((value as number) <= current.edges) {
      return { ok: false, reason: "budget update must strictly raise the current effective value" };
    }
    if ((value as number) > HANDOFF_BUDGET_MAX_EDGES) {
      return { ok: false, reason: "budget edges exceed the fixed cap" };
    }
    edges = value as number;
  }
  if (hasRework) {
    const value = candidate.reworkRounds;
    if (!isFiniteInteger(value) || (value as number) <= 0) {
      return { ok: false, reason: "budget rework rounds must be a positive integer" };
    }
    if ((value as number) <= current.reworkRounds) {
      return { ok: false, reason: "budget update must strictly raise the current effective value" };
    }
    if ((value as number) > HANDOFF_BUDGET_MAX_REWORK_ROUNDS) {
      return { ok: false, reason: "budget rework rounds exceed the fixed cap" };
    }
    reworkRounds = value as number;
  }
  const result: HandoffBudgetCandidateValidation = { ok: true };
  if (edges !== undefined) result.edges = edges;
  if (reworkRounds !== undefined) result.reworkRounds = reworkRounds;
  return result;
}

interface DimensionUpdate {
  from: number;
  to: number;
}

function parseDimensionUpdate(
  value: { from: unknown; to: unknown } | undefined,
  cap: number,
): { ok: true; update: DimensionUpdate } | { ok: false; reason: string } {
  if (value === undefined || typeof value !== "object") {
    return { ok: false, reason: "budget update dimension is malformed" };
  }
  const { from, to } = value as { from: unknown; to: unknown };
  if (!isFiniteInteger(from) || !isFiniteInteger(to)) {
    return { ok: false, reason: "budget update dimension values must be finite integers" };
  }
  if ((to as number) <= (from as number)) {
    return { ok: false, reason: "budget update must strictly raise (to must exceed from)" };
  }
  if ((to as number) > cap) {
    return { ok: false, reason: "budget update exceeds the fixed cap" };
  }
  return { ok: true, update: { from: from as number, to: to as number } };
}

/**
 * Canonical, bounded record serialization used ONLY as the final
 * deterministic tie-break for the derivation ordering (e.g. two records
 * colliding on both sequence and eventId). Field order is fixed; absent
 * dimensions render as "-"; malformed values reduce to bounded safe type
 * tags without coercion (this key is never surfaced in warnings or ignored
 * reasons).
 */
function canonicalEvidenceKey(update: HandoffBudgetUpdateEvidence): string {
  // Runtime evidence is deliberately tested with malformed values. Never
  // stringify/coerce one before validation: user-defined `toString` must not
  // turn fail-closed evidence rejection into a thrown derivation.
  const scalar = (value: unknown): string => {
    if (isFiniteInteger(value)) return `integer:${value}`;
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    return typeof value;
  };
  const dimension = (value: unknown): string => {
    if (value === undefined) return "-";
    if (value === null || typeof value !== "object") return `malformed:${scalar(value)}`;
    const record = value as { from?: unknown; to?: unknown };
    return `from:${scalar(record.from)};to:${scalar(record.to)}`;
  };
  return [
    scalar(update.kind),
    scalar(update.author),
    scalar(update.authorKind),
    scalar(update.rootEventId),
    scalar(update.correlationId),
    dimension(update.edges),
    dimension(update.reworkRounds),
  ].join("|");
}

/** Compare two strings deterministically (lexicographic by code unit). */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Total deterministic evidence ordering: ascending valid durable sequence
 * first (malformed/non-positive sequences sort last, deterministically);
 * then eventId; then the canonical record serialization. Never mutates the
 * inputs and never lets malformed/duplicate evidence alter effective values
 * — it only fixes the application/inspection order.
 */
function orderEvidenceForDerivation(
  updates: readonly HandoffBudgetUpdateEvidence[],
): HandoffBudgetUpdateEvidence[] {
  return [...updates].sort((a, b) => {
    const seqA = isFiniteInteger(a.sequence) && a.sequence >= 1 ? a.sequence : Number.POSITIVE_INFINITY;
    const seqB = isFiniteInteger(b.sequence) && b.sequence >= 1 ? b.sequence : Number.POSITIVE_INFINITY;
    if (seqA !== seqB) return seqA - seqB;
    const idCompare = compareStrings(a.eventId, b.eventId);
    if (idCompare !== 0) return idCompare;
    return compareStrings(canonicalEvidenceKey(a), canonicalEvidenceKey(b));
  });
}

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
export function deriveHandoffBudget(input: {
  rootEventId: string;
  updates: readonly HandoffBudgetUpdateEvidence[];
  usage: HandoffBudgetUsage;
}): DerivedHandoffBudget {
  const base = handoffBudgetBase();
  const effective: HandoffBudgetValue = { ...base };
  const validUpdateEventIds: string[] = [];
  const ignored: IgnoredHandoffBudgetUpdate[] = [];

  const ordered = orderEvidenceForDerivation(input.updates);

  // Duplicate durable identity/order is corrupt/replay evidence and fails
  // closed as a whole group (contract §3.2; B1 correction): a durable event
  // id or a durable sequence position identifies exactly one record. Counts
  // are computed over usable identities/sequences only, so the rejection is
  // deterministic and caller-order-independent. The total evidence ordering
  // above additionally makes the ordered `ignored` metadata itself
  // caller-order-independent.
  const identityCounts = new Map<string, number>();
  const sequenceCounts = new Map<number, number>();
  for (const update of ordered) {
    if (typeof update.eventId === "string" && update.eventId !== "") {
      identityCounts.set(update.eventId, (identityCounts.get(update.eventId) ?? 0) + 1);
    }
    if (isFiniteInteger(update.sequence) && (update.sequence as number) >= 1) {
      const seq = update.sequence as number;
      sequenceCounts.set(seq, (sequenceCounts.get(seq) ?? 0) + 1);
    }
  }

  for (const update of ordered) {
    const sequence: number | null = isFiniteInteger(update.sequence) && update.sequence >= 1 ? update.sequence : null;
    const eventId = typeof update.eventId === "string" && update.eventId !== "" ? update.eventId : "(unidentified)";

    // Shape validity: usable identity, exact kind, durable steward author
    // identity and kind, exact-root correlation.
    if (eventId === "(unidentified)") {
      ignored.push({ eventId, sequence: null, reason: "budget update evidence id is missing or malformed" });
      continue;
    }
    if (!isFiniteInteger(update.sequence) || (update.sequence as number) < 1) {
      ignored.push({ eventId, sequence, reason: "budget update sequence is malformed" });
      continue;
    }
    if ((identityCounts.get(update.eventId) ?? 0) > 1) {
      ignored.push({ eventId, sequence, reason: "duplicate evidence identity (replay or corruption); the whole group is rejected" });
      continue;
    }
    if ((sequenceCounts.get(update.sequence as number) ?? 0) > 1) {
      ignored.push({ eventId, sequence, reason: "duplicate durable sequence (corrupt ordering); the whole sequence group is rejected" });
      continue;
    }
    if (update.kind !== HANDOFF_BUDGET_UPDATE_KIND) {
      ignored.push({ eventId, sequence, reason: "evidence kind is not a budget update" });
      continue;
    }
    if (update.author !== HANDOFF_BUDGET_AUTHOR || update.authorKind !== HANDOFF_BUDGET_AUTHOR_KIND) {
      ignored.push({ eventId, sequence, reason: "budget updates are steward-authored only" });
      continue;
    }
    if (update.correlationId !== input.rootEventId || update.rootEventId !== input.rootEventId) {
      ignored.push({ eventId, sequence, reason: "budget update is correlated to a different workflow root" });
      continue;
    }

    const hasEdges = update.edges !== undefined;
    const hasRework = update.reworkRounds !== undefined;
    if (!hasEdges && !hasRework) {
      ignored.push({ eventId, sequence, reason: "budget update mentions no dimension" });
      continue;
    }

    // Chain validation per mentioned dimension; one failing dimension fails
    // the whole update (fail closed, never partially applied).
    let failure: string | undefined;
    const edgesResult = hasEdges ? parseDimensionUpdate(update.edges, HANDOFF_BUDGET_MAX_EDGES) : undefined;
    const reworkResult = hasRework ? parseDimensionUpdate(update.reworkRounds, HANDOFF_BUDGET_MAX_REWORK_ROUNDS) : undefined;
    if (edgesResult !== undefined && !edgesResult.ok) failure = edgesResult.reason;
    else if (reworkResult !== undefined && !reworkResult.ok) failure = reworkResult.reason;
    else if (edgesResult !== undefined && edgesResult.ok && edgesResult.update.from !== effective.edges) {
      failure = "budget update from-value does not match the current effective edges value";
    } else if (reworkResult !== undefined && reworkResult.ok && reworkResult.update.from !== effective.reworkRounds) {
      failure = "budget update from-value does not match the current effective rework value";
    }
    if (failure !== undefined) {
      ignored.push({ eventId, sequence, reason: failure });
      continue;
    }

    if (edgesResult !== undefined && edgesResult.ok) effective.edges = edgesResult.update.to;
    if (reworkResult !== undefined && reworkResult.ok) effective.reworkRounds = reworkResult.update.to;
    validUpdateEventIds.push(eventId);
  }

  const consumedEdges = input.usage.consumedEdges;
  const worstPairOccurrences = input.usage.worstPairOccurrences;
  const remainingEdges = effective.edges - consumedEdges;
  const remainingReworkRounds = 1 + effective.reworkRounds - worstPairOccurrences;
  const exhausted = consumedEdges >= effective.edges;
  const low = remainingEdges <= HANDOFF_BUDGET_LOW_EDGES_REMAINING || remainingReworkRounds <= HANDOFF_BUDGET_LOW_REWORK_REMAINING;
  return {
    rootEventId: input.rootEventId,
    base,
    effective,
    consumedEdges,
    remainingEdges,
    worstPairOccurrences,
    remainingReworkRounds,
    validUpdateEventIds,
    ignored,
    exhausted,
    low,
  };
}
