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
import { type ValidatedRecipients } from "./conversation-contract.js";
export declare const CONVERSATION_STATUSES: readonly ["open", "archived"];
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export declare const CONVERSATION_EVENT_KINDS: readonly ["steward_message", "run_started", "agent_message", "run_finished", "run_cancelled"];
export type ConversationEventKind = (typeof CONVERSATION_EVENT_KINDS)[number];
export declare const CONVERSATION_AUTHOR_KINDS: readonly ["steward", "agent", "system"];
export type ConversationAuthorKind = (typeof CONVERSATION_AUTHOR_KINDS)[number];
export declare const CONVERSATION_RUN_STATUSES: readonly ["running", "completed", "failed", "timed_out", "cancelled"];
export type ConversationRunStatus = (typeof CONVERSATION_RUN_STATUSES)[number];
export declare const CONVERSATION_RUN_FAILURE_KINDS: readonly ["launch_failure", "ambiguous"];
export type ConversationRunFailureKind = (typeof CONVERSATION_RUN_FAILURE_KINDS)[number];
/** Deterministic compact-UTC timestamp: `20260805T131530000Z`. */
export declare function compactConversationTimestamp(date: Date): string;
/** Deterministic conversation id from the first message (no LLM). */
export declare function conversationIdFromText(text: string, now: Date): string;
/** Deterministic display title from the first message (no LLM). */
export declare function conversationTitleFromText(text: string, now: Date): string;
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
    /** C1-validated steward recipients (first-mention order); the ONLY membership-growing act. */
    additions: ValidatedRecipients;
    now?: () => Date;
    /** Deterministic test seam: a barrier awaited while holding the audience lock. */
    holdBarrier?: Promise<void> | undefined;
    /** Deterministic test seam for the lock token. */
    lockToken?: () => string;
}
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
    body: string;
    path: string;
}
/** Read durable Conversation events in strict append order (sequence primary, created/id defensive tiebreak). */
export declare function readConversationEvents(options: ReadConversationEventsOptions): Promise<ConversationEventRecord[]>;
