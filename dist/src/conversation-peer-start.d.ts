/**
 * P3.1 (workbench-ux-follow-up-design §1.3; accepted P2 contract
 * `Projects/Piren/conversation-peer-audience-start-implementation-contract.md`)
 * — the pure peer-audience Dashboard-start contract core.
 *
 * Browser/gateway/filesystem-free and config-free: strict unknown-input
 * parsing of the exact `{peers}` envelope, 2–8 cardinality, blank/
 * name-grammar/duplicate rejection (duplicates are never collapsed),
 * deterministic creation-time canonical sorting of the validated initial set,
 * the immutable generic cardinal title, the truthful system-origin body, and
 * an optional injected runnable-set validation. Ordering is provenance/display
 * stability for the initial set only — never a lead, priority, rank, or turn
 * order — and later M1 growth appends without re-sorting (unchanged behavior).
 *
 * This core performs no HTTP, manifest/event write, SSE, broker call, or UI
 * work: every durable/browser effect remains separately gated.
 */
/** Exact accepted cardinality bounds for one peer-audience creation. */
export declare const PEER_AUDIENCE_MIN = 2;
export declare const PEER_AUDIENCE_MAX = 8;
/** One rejected peer: string entries echo only the name with its reason;
 * non-string entries are identified by array index only (never coerced,
 * never echoed). */
export type PeerStartInvalidMember = {
    peer: string;
    reason: "blank" | "invalid-name" | "duplicate";
    index: number;
} | {
    reason: "non-string";
    index: number;
};
export type ParsePeerAudienceStartResult = {
    ok: true; /** Canonically sorted (byte-wise ascending) initial audience. */
    audience: string[];
} | {
    ok: false;
    failure: {
        kind: "malformed-envelope";
        detail: string;
    } | {
        kind: "cardinality";
        count: number;
    } | {
        kind: "invalid-members";
        members: PeerStartInvalidMember[];
    };
};
/**
 * Strict parser for the exact `{peers}` request envelope. Deterministic
 * validation order: envelope shape → raw cardinality (2–8) → per-member
 * blank/grammar checks → duplicate detection. On success the returned
 * audience is the unique validated names sorted ascending byte-wise.
 */
export declare function parsePeerAudienceStartRequest(input: unknown): ParsePeerAudienceStartResult;
/**
 * Immutable generic cardinal title (P2 §4): `Conversation with N agents` for
 * the validated creation count. Never recomputed on later M1 growth; no member
 * enumeration; no role/order meaning. Throws outside the created 2–8 range so
 * a caller can never persist a title for an unvalidated count.
 */
export declare function peerConversationTitle(memberCount: number): string;
/**
 * Truthful system-origin body over the canonically ordered initial audience:
 * names every requested member, claims nothing about dispatch, attention, or
 * any run state.
 */
export declare function peerStartOriginBody(audience: readonly string[]): string;
export type PeerRunnableValidationResult = {
    ok: true;
} | {
    ok: false;
    notRunnable: Array<{
        peer: string;
        index: number;
    }>;
};
/**
 * Optional pure runnable-set validation against an INJECTED set (the gateway's
 * resolved local runnable set in production). Never reads configuration; whole-
 * set semantics: any non-runnable member fails with its name AND position.
 * NOTE: a returned index is the position in the audience array passed to THIS
 * helper — after creation-side canonical sorting that is NOT necessarily the
 * raw submitted request position. Callers must not report these indexes as
 * request entries.
 */
export declare function validatePeerRunnability(audience: readonly string[], runnableAgents: readonly string[]): PeerRunnableValidationResult;
