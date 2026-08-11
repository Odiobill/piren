/**
 * C2 — Conversation durable record core (ADR-0042, accepted C2 contract §1).
 *
 * Owns the Conversation Manifest and immutable event records under the
 * DISTINCT additive namespace `collaboration/conversations/<id>/`. This is a
 * sibling tree: it never writes, scans, renames, or deletes
 * `collaboration/rooms/**`, and no room code is generalized or changed. The
 * semantics deliberately mirror the proven room record conventions (atomic
 * no-clobber writes, deterministic compact-UTC ids, tolerant list, strict
 * manifest/event validation naming their path) without importing or altering
 * room types.
 *
 * A Conversation exists only after activation (first message); a draft has no
 * record. The manifest carries the additive `audience` membership, which grows
 * only through validated steward mentions (C1 `applyMembershipChange`).
 *
 * This module is a pure core over an injected write seam: every behavior is
 * unit-testable without Pi auth or a real filesystem beyond the caller's io.
 */
import { type ConversationLifecycleTransition, type ValidatedRecipients } from "./conversation-contract.js";
export declare const CONVERSATION_STATUSES: readonly ["open", "archived"];
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export declare const CONVERSATION_EVENT_KINDS: readonly ["steward_message", "run_started", "agent_message", "model_fallback", "run_finished", "run_cancelled", "lifecycle_transition", "conversation_renamed"];
export type ConversationEventKind = (typeof CONVERSATION_EVENT_KINDS)[number];
export declare const CONVERSATION_AUTHOR_KINDS: readonly ["steward", "agent", "system"];
export type ConversationAuthorKind = (typeof CONVERSATION_AUTHOR_KINDS)[number];
export declare const CONVERSATION_RUN_STATUSES: readonly ["running", "completed", "failed", "timed_out", "cancelled"];
export type ConversationRunStatus = (typeof CONVERSATION_RUN_STATUSES)[number];
export declare const CONVERSATION_RUN_FAILURE_KINDS: readonly ["launch_failure", "ambiguous", "provider_error"];
export type ConversationRunFailureKind = (typeof CONVERSATION_RUN_FAILURE_KINDS)[number];
/** U2: bounded rename title length in UTF-16 code units (contract §Rename input). */
export declare const CONVERSATION_TITLE_MAX = 120;
/** Deterministic compact-UTC timestamp: `20260805T131530000Z`. */
export declare function compactConversationTimestamp(date: Date): string;
/** Deterministic conversation id from the first message (no LLM). */
export declare function conversationIdFromText(text: string, now: Date): string;
/** Deterministic display title from the first message (no LLM). */
export declare function conversationTitleFromText(text: string, now: Date): string;
/**
 * U2 — bounded rename title validation and trim normalization (contract
 * §Rename input, exact): the trim-normalized value must be a single line of
 * 1–120 Unicode code units. Empty, control/newline-containing (including
 * Unicode line separators), and overlength values fail with exact reasons.
 * The value is stored exactly after trim; it is never LLM-derived, slugged,
 * used to derive the id, or parsed for `@` mentions.
 */
export type ConversationTitleValidation = {
    ok: true;
    title: string;
} | {
    ok: false;
    reason: "empty" | "control-or-newline" | "too-long";
};
export declare function normalizeConversationTitle(raw: string): ConversationTitleValidation;
/** Non-secret deterministic message for a rejected rename title (gateway 400). */
export declare function conversationTitleErrorMessage(reason: "empty" | "control-or-newline" | "too-long"): string;
/** Injected final-target seam (mirrors the room write seam; never imports room types). */
export interface ConversationWriteIo {
    /** Hard-link temp to target; MUST reject when the target already exists. */
    linkNoClobber(tempPath: string, targetPath: string): Promise<void>;
    /** Remove a file, tolerating a missing path. */
    remove(absolutePath: string): Promise<void>;
}
export interface ConversationManifest {
    id: string;
    title: string;
    audience: readonly string[];
    status: ConversationStatus;
    createdBy: string;
    created: string;
    updated: string;
    path: string;
    absolutePath: string;
}
export interface CreateConversationOptions {
    vaultRoot: string;
    /** Raw first-message text (validated by the caller before any durable write). */
    text: string;
    /** Additive audience from the C1 validated recipients (first-mention order). */
    audience: readonly string[];
    now?: () => Date;
    nonce?: () => string;
    io?: ConversationWriteIo;
}
export interface CreateConversationResult extends ConversationManifest {
    bytes: number;
}
/** Create + activate a Conversation from its first message (atomic no-clobber). */
export declare function createConversation(options: CreateConversationOptions): Promise<CreateConversationResult>;
export interface UpdateConversationAudienceOptions {
    vaultRoot: string;
    conversationId: string;
    /** C1-validated recipients (first-mention order); additive-only membership growth. */
    additions: ValidatedRecipients;
    /**
     * Membership provenance: `steward` (validated mentions, the historic
     * growing act) or `handoff` (C5 steward-approved workflow exception,
     * ADR-0042 amendment 2026-08-07). Both apply additively via C1
     * `applyMembershipChange`; agent addresses never grow membership.
     */
    kind?: "steward" | "handoff" | undefined;
    now?: () => Date;
    /** Deterministic test seam: a barrier awaited while holding the audience lock. */
    holdBarrier?: Promise<void> | undefined;
    /** Deterministic test seam for the lock token. */
    lockToken?: () => string;
}
/**
 * Acquire the per-conversation audience-update lock (vault-visible,
 * no-clobber, cross-process safe): an atomic no-clobber create of
 * `collaboration/conversations/<id>/.audience.lock`. A held/contended lock
 * rejects with a deterministic non-secret conflict — the CALLER surfaces it
 * as 409 BEFORE creating any steward event or dispatch (no false delivery
 * claim). There is NO automatic stale recovery; a crashed holder's lock is
 * recovered manually (see the C2 contract): inspect the lock content, then
 * remove the file after triage. The release removes ONLY our own lock
 * (token-verified) so a manually replaced lock is never deleted by a stale
 * holder. No hidden DB, queue, retry, or fallback.
 *
 * Exported as a test seam (C5-1 lock-failure containment): tests hold the
 * lock to prove a busy audience append is contained.
 */
export declare function acquireAudienceLock(options: {
    vaultRoot: string;
    conversationId: string;
    now?: () => Date;
    token?: () => string;
}): Promise<{
    release: () => Promise<void>;
}>;
/**
 * C2 additive later-mention membership seam: grow the durable manifest
 * `audience` with validated steward recipients only, preserving existing
 * first-mention order with no removals/reordering (C1 `applyMembershipChange`
 * steward path), preserve the original `created` byte-for-byte, and bump only
 * `updated`.
 *
 * Concurrency safety: the read -> C1 union -> atomic manifest replacement is
 * guarded by the per-conversation vault-visible `.audience.lock` (acquired
 * before any read; released in a `finally`, token-verified). A contended lock
 * rejects with a deterministic non-secret conflict that the gateway surfaces
 * as 409 BEFORE creating the steward event or dispatching, so concurrent
 * additions can never silently lose a member. There is no automatic stale
 * recovery (manual recovery of a crashed holder is documented in the C2
 * contract); no hidden DB, queue, retry, or fallback.
 */
export declare function updateConversationAudience(options: UpdateConversationAudienceOptions): Promise<ConversationManifest>;
/**
 * L1 — durable Conversation lifecycle transitions (accepted archive/reopen
 * contract §4/§5, selected defaults).
 *
 * `transitionConversationLifecycle` performs the complete read → C1 state
 * verify → manifest atomic rewrite → lifecycle-event append sequence under the
 * existing per-conversation no-clobber lock. Only `open → archived` (archive)
 * and `archived → open` (reopen) mutate; a request whose target state already
 * matches the manifest returns a typed idempotent no-op with NO write and NO
 * event. Exactly one immutable `lifecycle_transition` event (author steward,
 * optional `lifecycleState` metadata) is appended for an actual transition.
 *
 * Failure boundaries (typed, no hidden state): a held lock fails closed as
 * `lock-busy` before any manifest write or event; an event-append failure
 * leaves the transitioned manifest authoritative (never rolled back,
 * auto-repaired, or retried) and returns `event-append-failed` with the
 * transitioned manifest — suitable for a later gateway slice to surface as the
 * contract's bounded 500. The helper never creates a broker/Pi client/session,
 * dispatches, retries, reroutes, aborts, attaches, streams, or changes
 * membership.
 */
export type ConversationLifecycleTransitionKind = Extract<ConversationLifecycleTransition, "archive" | "reopen">;
export interface TransitionConversationLifecycleOptions {
    vaultRoot: string;
    conversationId: string;
    transition: ConversationLifecycleTransitionKind;
    now?: () => Date;
    nonce?: () => string;
    io?: ConversationWriteIo | undefined;
    /** Deterministic test seam for the lock token. */
    lockToken?: () => string;
    /** Deterministic test seam: a barrier awaited while holding the lock. */
    holdBarrier?: Promise<void> | undefined;
}
export type ConversationLifecycleTransitionResult = {
    ok: true;
    transitioned: true;
    conversation: ConversationManifest;
    event: AppendConversationEventResult;
} | {
    ok: true;
    transitioned: false;
    conversation: ConversationManifest;
} | {
    ok: false;
    kind: "lock-busy";
    conversationId: string;
} | {
    ok: false;
    kind: "event-append-failed";
    conversationId: string;
    conversation: ConversationManifest;
};
export declare function transitionConversationLifecycle(options: TransitionConversationLifecycleOptions): Promise<ConversationLifecycleTransitionResult>;
/**
 * U2 — durable Conversation rename (accepted details/rename contract
 * §Rename input and durable core).
 *
 * A bounded steward-facing title change: the trim-normalized single-line
 * title (1–120 Unicode code units) replaces ONLY `title` and `updated` in the
 * manifest, atomically, under the same per-conversation transition lock as
 * audience updates and archive/reopen; `id`, `audience`, `status`,
 * `created_by`, and `created` are preserved byte-for-byte. Every actual
 * rename appends exactly one immutable `conversation_renamed` event (author
 * steward) carrying both bounded titles (`previousTitle`, `title`); the
 * manifest remains authoritative — the event is evidence, not authority.
 *
 * A request whose normalized title equals the durable title is an idempotent
 * `renamed:false` result: no manifest rewrite, timestamp change, or event.
 * An archived Conversation remains renameable (title presentation is
 * independent of attach state).
 *
 * Failure boundaries (typed, no hidden state): invalid titles return
 * `invalid-title` with a non-secret message before any lock/write; a held
 * lock fails closed as `lock-busy` before any manifest write or event; an
 * event-append failure leaves the renamed manifest authoritative (never
 * rolled back, auto-repaired, or retried) and returns
 * `event-append-failed` with the renamed manifest. The helper never creates
 * a broker/Pi client/session, dispatches, retries, reroutes, aborts,
 * attaches, streams, or changes membership.
 */
export interface RenameConversationOptions {
    vaultRoot: string;
    conversationId: string;
    /** Raw request title; validated and trim-normalized here. */
    title: string;
    now?: () => Date;
    nonce?: () => string;
    io?: ConversationWriteIo | undefined;
    /** Deterministic test seam for the lock token. */
    lockToken?: () => string;
    /** Deterministic test seam: a barrier awaited while holding the lock. */
    holdBarrier?: Promise<void> | undefined;
}
export type RenameConversationResult = {
    ok: true;
    renamed: true;
    conversation: ConversationManifest;
    event: AppendConversationEventResult;
    /** Bounded prior title evidence echoed to the client. */
    previousTitle: string;
    /** Bounded new title evidence echoed to the client. */
    title: string;
} | {
    ok: true;
    renamed: false;
    conversation: ConversationManifest;
} | {
    ok: false;
    kind: "invalid-title";
    conversationId: string;
    message: string;
} | {
    ok: false;
    kind: "lock-busy";
    conversationId: string;
} | {
    ok: false;
    kind: "event-append-failed";
    conversationId: string;
    conversation: ConversationManifest;
};
export declare function renameConversation(options: RenameConversationOptions): Promise<RenameConversationResult>;
export interface AppendConversationEventOptions {
    vaultRoot: string;
    conversationId: string;
    kind: ConversationEventKind;
    authorKind: ConversationAuthorKind;
    author: string;
    body: string;
    /** Validated steward mentions for a steward_message (dispatch metadata). */
    mentions?: readonly string[] | undefined;
    correlationId?: string | undefined;
    addressedAgent?: string | undefined;
    runStatus?: ConversationRunStatus | undefined;
    failureKind?: ConversationRunFailureKind | undefined;
    /** C2 context-handoff selection metadata (inspectable dispatch metadata). */
    contextMetadata?: ConversationContextMetadata | undefined;
    /** L1 lifecycle-transition target state metadata (additive, optional). */
    lifecycleState?: ConversationStatus | undefined;
    /** U2 conversation_renamed evidence: the bounded prior title (optional, additive). */
    previousTitle?: string | undefined;
    /** U2 conversation_renamed evidence: the bounded new title (optional, additive). */
    title?: string | undefined;
    now?: () => Date;
    nonce?: () => string;
    io?: ConversationWriteIo | undefined;
    /** Injected sequence counter (testable); production derives it from the event count. */
    sequence?: number | undefined;
}
/** C2 context-handoff selection metadata (shape mirrors C1 selection metadata). */
export interface ConversationContextMetadata {
    truncated: boolean;
    selectedIds: string[];
    omittedIds: string[];
    selectedCount: number;
    omittedCount: number;
    selectedChars: number;
    maxItems: number;
    maxChars: number;
}
export interface AppendConversationEventResult {
    id: string;
    path: string;
    absolutePath: string;
    conversationId: string;
    kind: ConversationEventKind;
    created: string;
    /** Atomic durable append sequence (1-based, strictly increasing). */
    sequence: number;
    bytes: number;
}
/** Append one immutable Conversation event (no-clobber). */
export declare function appendConversationEvent(options: AppendConversationEventOptions): Promise<AppendConversationEventResult>;
export interface ReadConversationOptions {
    vaultRoot: string;
    conversationId: string;
}
export declare function readConversation(options: ReadConversationOptions): Promise<ConversationManifest>;
export interface ListConversationsOptions {
    vaultRoot: string;
}
/** List Conversation manifests, newest-first (created desc, id asc tiebreak). */
export declare function listConversations(options: ListConversationsOptions): Promise<ConversationManifest[]>;
export interface ReadConversationEventsOptions {
    vaultRoot: string;
    conversationId: string;
}
export interface ConversationEventRecord {
    id: string;
    conversationId: string;
    kind: ConversationEventKind;
    authorKind: ConversationAuthorKind;
    author: string;
    created: string;
    /** Monotonic per-conversation append order (1-based); the durable-order tiebreak. */
    sequence: number;
    mentions: readonly string[];
    correlationId?: string | undefined;
    addressedAgent?: string | undefined;
    runStatus?: ConversationRunStatus | undefined;
    failureKind?: ConversationRunFailureKind | undefined;
    contextMetadata?: ConversationContextMetadata | undefined;
    /** L1 lifecycle-transition target state metadata (additive, optional). */
    lifecycleState?: ConversationStatus | undefined;
    /** U2 conversation_renamed evidence: the bounded prior title (additive, optional). */
    previousTitle?: string | undefined;
    /** U2 conversation_renamed evidence: the bounded new title (additive, optional). */
    title?: string | undefined;
    body: string;
    path: string;
}
/** Read durable Conversation events in strict append order (sequence primary, created/id defensive tiebreak). */
export declare function readConversationEvents(options: ReadConversationEventsOptions): Promise<ConversationEventRecord[]>;
