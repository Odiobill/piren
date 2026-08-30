/**
 * B1 (accepted W2/W3 contract §2/§3.2) — pure, bounded Conversation
 * handoff-budget core.
 *
 * I/O-free and directly unit-testable: bases/caps are fixed constants, an
 * update candidate is validated against the current effective values, and
 * the per-root effective budget is derived from injected typed update
 * evidence plus injected workflow usage facts — never from filesystem,
 * broker, gateway, browser, or local-config state. Later layers (B3
 * broker/gateway adapter, B5/B6 UI) compose with this core; B1 itself adds
 * no durable kinds and no event parsing/rendering. (B2 correction: the
 * `handoffBudgetEvidenceFromRecord` adapter below is the deliberately
 * type-only durable-record seam — it maps parsed production
 * `ConversationEventRecord`s onto the B1 evidence shape without any runtime
 * dependency; B2 owns that mapping and B1's derivation policy is unchanged.)
 *
 * Fail-closed semantics (contract §3.2): an evidence update applies per the
 * whole-event rule only when its shape is valid (root/kind/steward author/
 * correlation), each mentioned dimension's `from` equals that dimension's
 * immediately prior effective value, `to` strictly raises, and `to` is
 * within the fixed caps. Any invalid, stale, lower, duplicate, replay, or
 * malformed update is ignored with bounded inspectable warning metadata and
 * never widens or lowers the effective budget.
 */
import { CONVERSATION_HANDOFF_MAX_EDGES, CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS, } from "./conversation-handoff.js";
/** Fixed hard cap for the adjustable per-root edges budget (contract §2.2). */
export const HANDOFF_BUDGET_MAX_EDGES = 24;
/** Fixed hard cap for the adjustable per-root rework-rounds budget (contract §2.2). */
export const HANDOFF_BUDGET_MAX_REWORK_ROUNDS = 6;
/** The C5-aligned base budget; the existing C5 constants are reused unchanged. */
export function handoffBudgetBase() {
    return { edges: CONVERSATION_HANDOFF_MAX_EDGES, reworkRounds: CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS };
}
const HANDOFF_BUDGET_UPDATE_KIND = "handoff_budget_updated";
const HANDOFF_BUDGET_AUTHOR = "steward";
const HANDOFF_BUDGET_AUTHOR_KIND = "steward";
/** Contract §2.4: the low threshold for remaining edges. */
const HANDOFF_BUDGET_LOW_EDGES_REMAINING = 2;
/** Contract §2.4: the low threshold for worst-pair remaining rework rounds. */
const HANDOFF_BUDGET_LOW_REWORK_REMAINING = 1;
function isFiniteInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}
export function validateHandoffBudgetUpdateCandidate(input) {
    const { candidate, current } = input;
    const hasEdges = candidate.edges !== undefined;
    const hasRework = candidate.reworkRounds !== undefined;
    if (!hasEdges && !hasRework) {
        return { ok: false, reason: "budget update requires at least one dimension" };
    }
    let edges;
    let reworkRounds;
    if (hasEdges) {
        const value = candidate.edges;
        if (!isFiniteInteger(value) || value <= 0) {
            return { ok: false, reason: "budget edges must be a positive integer" };
        }
        if (value <= current.edges) {
            return { ok: false, reason: "budget update must strictly raise the current effective value" };
        }
        if (value > HANDOFF_BUDGET_MAX_EDGES) {
            return { ok: false, reason: "budget edges exceed the fixed cap" };
        }
        edges = value;
    }
    if (hasRework) {
        const value = candidate.reworkRounds;
        if (!isFiniteInteger(value) || value <= 0) {
            return { ok: false, reason: "budget rework rounds must be a positive integer" };
        }
        if (value <= current.reworkRounds) {
            return { ok: false, reason: "budget update must strictly raise the current effective value" };
        }
        if (value > HANDOFF_BUDGET_MAX_REWORK_ROUNDS) {
            return { ok: false, reason: "budget rework rounds exceed the fixed cap" };
        }
        reworkRounds = value;
    }
    const result = { ok: true };
    if (edges !== undefined)
        result.edges = edges;
    if (reworkRounds !== undefined)
        result.reworkRounds = reworkRounds;
    return result;
}
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
export function handoffBudgetEvidenceFromRecord(record, rootEventId) {
    const evidence = {
        eventId: record.id,
        sequence: record.sequence,
        kind: record.kind,
        author: record.author,
        authorKind: record.authorKind,
        rootEventId,
        correlationId: record.correlationId ?? "",
    };
    const payload = record.handoffBudget;
    if (payload !== undefined) {
        if (payload.edges !== undefined)
            evidence.edges = payload.edges;
        if (payload.reworkRounds !== undefined)
            evidence.reworkRounds = payload.reworkRounds;
    }
    return evidence;
}
function parseDimensionUpdate(value, cap) {
    if (value === undefined || typeof value !== "object") {
        return { ok: false, reason: "budget update dimension is malformed" };
    }
    const { from, to } = value;
    if (!isFiniteInteger(from) || !isFiniteInteger(to)) {
        return { ok: false, reason: "budget update dimension values must be finite integers" };
    }
    if (to <= from) {
        return { ok: false, reason: "budget update must strictly raise (to must exceed from)" };
    }
    if (to > cap) {
        return { ok: false, reason: "budget update exceeds the fixed cap" };
    }
    return { ok: true, update: { from: from, to: to } };
}
/**
 * Canonical, bounded record serialization used ONLY as the final
 * deterministic tie-break for the derivation ordering (e.g. two records
 * colliding on both sequence and eventId). Field order is fixed; absent
 * dimensions render as "-"; malformed values reduce to bounded safe type
 * tags without coercion (this key is never surfaced in warnings or ignored
 * reasons).
 */
function canonicalEvidenceKey(update) {
    // Runtime evidence is deliberately tested with malformed values. Never
    // stringify/coerce one before validation: user-defined `toString` must not
    // turn fail-closed evidence rejection into a thrown derivation.
    const scalar = (value) => {
        if (isFiniteInteger(value))
            return `integer:${value}`;
        if (value === undefined)
            return "undefined";
        if (value === null)
            return "null";
        return typeof value;
    };
    const dimension = (value) => {
        if (value === undefined)
            return "-";
        if (value === null || typeof value !== "object")
            return `malformed:${scalar(value)}`;
        const record = value;
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
function compareStrings(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}
/**
 * Total deterministic evidence ordering: ascending valid durable sequence
 * first (malformed/non-positive sequences sort last, deterministically);
 * then eventId; then the canonical record serialization. Never mutates the
 * inputs and never lets malformed/duplicate evidence alter effective values
 * — it only fixes the application/inspection order.
 */
function orderEvidenceForDerivation(updates) {
    return [...updates].sort((a, b) => {
        const seqA = isFiniteInteger(a.sequence) && a.sequence >= 1 ? a.sequence : Number.POSITIVE_INFINITY;
        const seqB = isFiniteInteger(b.sequence) && b.sequence >= 1 ? b.sequence : Number.POSITIVE_INFINITY;
        if (seqA !== seqB)
            return seqA - seqB;
        const idCompare = compareStrings(a.eventId, b.eventId);
        if (idCompare !== 0)
            return idCompare;
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
export function deriveHandoffBudget(input) {
    const base = handoffBudgetBase();
    const effective = { ...base };
    const validUpdateEventIds = [];
    const ignored = [];
    const ordered = orderEvidenceForDerivation(input.updates);
    // Duplicate durable identity/order is corrupt/replay evidence and fails
    // closed as a whole group (contract §3.2; B1 correction): a durable event
    // id or a durable sequence position identifies exactly one record. Counts
    // are computed over usable identities/sequences only, so the rejection is
    // deterministic and caller-order-independent. The total evidence ordering
    // above additionally makes the ordered `ignored` metadata itself
    // caller-order-independent.
    const identityCounts = new Map();
    const sequenceCounts = new Map();
    for (const update of ordered) {
        if (typeof update.eventId === "string" && update.eventId !== "") {
            identityCounts.set(update.eventId, (identityCounts.get(update.eventId) ?? 0) + 1);
        }
        if (isFiniteInteger(update.sequence) && update.sequence >= 1) {
            const seq = update.sequence;
            sequenceCounts.set(seq, (sequenceCounts.get(seq) ?? 0) + 1);
        }
    }
    for (const update of ordered) {
        const sequence = isFiniteInteger(update.sequence) && update.sequence >= 1 ? update.sequence : null;
        const eventId = typeof update.eventId === "string" && update.eventId !== "" ? update.eventId : "(unidentified)";
        // Shape validity: usable identity, exact kind, durable steward author
        // identity and kind, exact-root correlation.
        if (eventId === "(unidentified)") {
            ignored.push({ eventId, sequence: null, reason: "budget update evidence id is missing or malformed" });
            continue;
        }
        if (!isFiniteInteger(update.sequence) || update.sequence < 1) {
            ignored.push({ eventId, sequence, reason: "budget update sequence is malformed" });
            continue;
        }
        if ((identityCounts.get(update.eventId) ?? 0) > 1) {
            ignored.push({ eventId, sequence, reason: "duplicate evidence identity (replay or corruption); the whole group is rejected" });
            continue;
        }
        if ((sequenceCounts.get(update.sequence) ?? 0) > 1) {
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
        let failure;
        const edgesResult = hasEdges ? parseDimensionUpdate(update.edges, HANDOFF_BUDGET_MAX_EDGES) : undefined;
        const reworkResult = hasRework ? parseDimensionUpdate(update.reworkRounds, HANDOFF_BUDGET_MAX_REWORK_ROUNDS) : undefined;
        if (edgesResult !== undefined && !edgesResult.ok)
            failure = edgesResult.reason;
        else if (reworkResult !== undefined && !reworkResult.ok)
            failure = reworkResult.reason;
        else if (edgesResult !== undefined && edgesResult.ok && edgesResult.update.from !== effective.edges) {
            failure = "budget update from-value does not match the current effective edges value";
        }
        else if (reworkResult !== undefined && reworkResult.ok && reworkResult.update.from !== effective.reworkRounds) {
            failure = "budget update from-value does not match the current effective rework value";
        }
        if (failure !== undefined) {
            ignored.push({ eventId, sequence, reason: failure });
            continue;
        }
        if (edgesResult !== undefined && edgesResult.ok)
            effective.edges = edgesResult.update.to;
        if (reworkResult !== undefined && reworkResult.ok)
            effective.reworkRounds = reworkResult.update.to;
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
//# sourceMappingURL=conversation-budget.js.map