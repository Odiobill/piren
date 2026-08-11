/**
 * C1 — pure Conversation/mention contract core (ADR-0042, Conversation-Native
 * Workbench Architecture Design §4-§8/§11-§13).
 *
 * This module is a pure, directly unit-testable contract core. It has NO
 * filesystem, network, Pi, gateway, browser, config, or vault dependency:
 * every input is injected by the caller (mention text, the local runnable-agent
 * set, durable membership, transcript items, budget policy). It never reads
 * room/vault records and never assembles Pi prompts.
 *
 * Implemented surface:
 *  - `scanStewardMentions`: deterministic `@<lowercase-kebab-agent>` scanner.
 *  - `resolveRecipients` / `resolveStewardMentions`: atomic resolution of
 *    recognized mentions against an injected local runnable-agent set.
 *  - `applyMembershipChange`: additive membership; steward-only growth with
 *    explicit provenance; agent-originated addresses are a byte-for-byte no-op.
 *  - `transitionLifecycle`: draft -> open -> archived lifecycle transitions.
 *  - `validateTranscriptBudget` / `selectDurableTranscript`: injected-only
 *    whole-item bounded durable-transcript replay with explicit truncation
 *    metadata. No default budget exists anywhere in this module.
 *  - `checkActiveGate` / `canOpenActive` / `isActionPermitted` and friends:
 *    open/switch/attach-as-active gate (every durable member locally runnable)
 *    versus always-read-only inspect/read-history.
 *
 * Grammar (canonical, server-authoritative; deliberately minimal, no Markdown
 * renderer): a steward mention is `@` followed by a lowercase-kebab agent name
 * (`^[a-z][a-z0-9-]*$`, the existing Piren agent-name pattern), recognized ONLY
 * at a token boundary (start of text, or preceded by a character that is not a
 * Unicode letter or number). Mentions inside inline code spans, fenced code blocks,
 * and quoted (blockquote) lines are never recognized. A doubled `@@` is an
 * escaped literal `@` at any position and never a mention. After a boundary
 * `@`, the scanner consumes the maximal run of `[A-Za-z0-9_-]`; if the full
 * token does not match the agent-name pattern, the `@` is ordinary text.
 *
 * Documented deterministic scanner regions:
 *  - Inline code spans are backtick runs; a run of length L opens a span, and
 *    only a later run of exactly L closes it (a run of a different length
 *    inside an open span is content). An unterminated span makes the rest of
 *    the text code (fail-safe). An open span takes precedence over quote/fence
 *    line classification.
 *  - Fenced code blocks open on a line with at most 3 leading spaces followed
 *    by a run of >=3 backticks or >=3 tildes (optional info string ignored),
 *    and close on a line with at most 3 leading spaces, the same fence
 *    character repeated at least the opening run length, then only whitespace.
 *    Indented-code blocks (4-space) are NOT a code region in this grammar.
 *  - Blockquote lines start with at most 3 leading spaces then `>`; the whole
 *    line is quoted text and never opens/closes fences (documented
 *    simplification: fence markers inside quote lines are not interpreted).
 *  - CRLF and legacy CR line endings are normalized to LF before region
 *    recognition, so line-oriented fence and quote behavior is deterministic.
 */
/** The lowercase-kebab agent-name pattern (mirrors the Piren agent pattern). */
export declare const CONVERSATION_AGENT_NAME_PATTERN: RegExp;
/** Deterministic name-syntax predicate for the mention grammar. */
export declare function isValidConversationAgentName(name: string): boolean;
/** Result of scanning one steward message for mentions. */
export interface MentionScan {
    /** Recognized agent names in first textual mention order (duplicates preserved). */
    readonly mentions: readonly string[];
}
/**
 * Deterministic steward `@<lowercase-kebab-agent>` recognition. See the module
 * header for the exact documented scanner semantics.
 */
export declare function scanStewardMentions(text: string): MentionScan;
/**
 * Opaque validated steward recipient set. Produced ONLY by the
 * `resolveRecipients`/`resolveStewardMentions` success path; the brand makes
 * provenance explicit so arbitrary string lists cannot masquerade as validated
 * recipients.
 */
export interface ValidatedRecipients {
    /** Brand: only resolution success produces this. */
    readonly __validatedRecipients: true;
    /** Deduplicated recipients in first textual mention order. */
    readonly recipients: readonly string[];
}
/** Deterministic, non-secret result of resolving recognized mentions. */
export type RecipientResolution = {
    ok: true;
    validated: ValidatedRecipients;
} | {
    ok: false;
    reason: "unknown-recipient";
    /** Unknown/non-runnable recipients, deduped, first mention order. */
    unknown: readonly string[];
    /** The injected local runnable set (echoed as passed). */
    runnableAgents: readonly string[];
    /** Deterministic non-secret human-readable message. */
    message: string;
};
/**
 * Resolve recognized steward mentions against the injected local runnable-agent
 * set (already `allowed_agents` minus `excluded_agents`). Any syntactically
 * recognized unknown/non-runnable recipient invalidates the WHOLE result
 * atomically: no partial recipient list is ever exposed. Valid recipients are
 * deduplicated and preserve first textual mention order.
 */
export declare function resolveRecipients(scan: MentionScan, runnableAgents: readonly string[]): RecipientResolution;
/** One-shot convenience: scan then resolve steward mentions. */
export declare function resolveStewardMentions(text: string, runnableAgents: readonly string[]): RecipientResolution;
/**
 * Membership change with explicit provenance.
 *  - `steward`: validated steward recipients (from resolution success) — the
 *    only membership-growing act (additive).
 *  - `handoff`: a validated agent-handoff target within an explicitly
 *    steward-approved Conversation workflow (C5, ADR-0042 amendment
 *    2026-08-07) — additive-only, finite, steward-sanctioned exception to
 *    the agent-address neutrality rule.
 *  - `agent`: an agent-originated address — asks a named agent to read/react
 *    within the current run and NEVER alters durable membership.
 */
export type MembershipChange = {
    kind: "steward";
    recipients: ValidatedRecipients;
} | {
    kind: "handoff";
    recipients: ValidatedRecipients;
} | {
    kind: "agent";
    to: string;
};
/**
 * Additive membership application. Steward and C5-handoff recipients are
 * added after existing members (never removing or reordering them;
 * already-present names are skipped). Agent-originated addresses return the
 * caller's membership array unchanged (same reference, byte-for-byte) and can
 * never grow membership.
 */
export declare function applyMembershipChange(existing: readonly string[], change: MembershipChange): readonly string[];
/** Durable conversation lifecycle states (C1: draft has no persistence). */
export type ConversationLifecycleState = "draft" | "open" | "archived";
/** Explicit durable lifecycle transitions. */
export type ConversationLifecycleTransition = "activate" | "archive" | "reopen";
export type LifecycleResult = {
    ok: true;
    next: ConversationLifecycleState;
} | {
    ok: false;
    reason: string;
};
/**
 * Pure lifecycle transition: draft -> open (activation), open -> archived
 * (archive), archived -> open (reopen). Everything else is rejected with a
 * deterministic reason. A draft has no persistence implication in C1.
 */
export declare function transitionLifecycle(current: ConversationLifecycleState, transition: ConversationLifecycleTransition): LifecycleResult;
/** One durable transcript item, supplied by the caller in durable order. */
export interface DurableTranscriptItem {
    id: string;
    text: string;
}
/** Caller-injected budget policy. Both caps are always required; no default. */
export interface TranscriptBudget {
    maxItems: number;
    maxChars: number;
}
/** Validated budget; produced only by `validateTranscriptBudget` success. */
export interface ValidatedTranscriptBudget {
    readonly __validatedBudget: true;
    readonly maxItems: number;
    readonly maxChars: number;
}
export type BudgetValidation = {
    ok: true;
    budget: ValidatedTranscriptBudget;
} | {
    ok: false;
    reason: string;
};
/** Fail-closed budget validation: both caps must be positive integers. */
export declare function validateTranscriptBudget(budget: TranscriptBudget): BudgetValidation;
/** Explicit truncation/selection metadata, always returned with an ok result. */
export interface TranscriptSelectionMetadata {
    /** True whenever any durable item was excluded (budget hit). */
    truncated: boolean;
    selectedCount: number;
    omittedCount: number;
    /** Total characters of the selected items' text (whole bodies only). */
    selectedChars: number;
    /** Selected item ids in durable chronological order. */
    selectedIds: readonly string[];
    /** Omitted item ids in durable chronological order. */
    omittedIds: readonly string[];
    maxItems: number;
    maxChars: number;
}
export type TranscriptSelection = {
    ok: true;
    selected: readonly DurableTranscriptItem[];
    metadata: TranscriptSelectionMetadata;
} | {
    ok: false;
    reason: "invalid-budget";
};
/**
 * Bounded durable-transcript selector.
 *
 * Inputs are caller-supplied durable transcript items in durable chronological
 * order plus an injected budget policy (validated fail-closed here — there is
 * no undocumented/default message or character budget). The selection is the
 * maximal newest contiguous suffix of WHOLE items that fits within both caps,
 * returned in durable chronological order. An item is never skipped to make
 * room for older items, and a body is never sliced: an item that alone exceeds
 * `maxChars` selects nothing, with explicit truncation metadata.
 */
export declare function selectDurableTranscript(items: readonly DurableTranscriptItem[], budget: TranscriptBudget): TranscriptSelection;
/** Result of the locally-runnable active-switch gate check. */
export interface ActiveGateResult {
    ok: boolean;
    /** Durable members absent from the injected local runnable set (deduped, durable order). */
    missing: readonly string[];
    /** Durable members that do not match the agent-name pattern (fail closed). */
    malformed: readonly string[];
}
/**
 * Deterministic non-secret rejection message for a failed active attach gate
 * (C3-A). Names the conversation and the durable member problem categories;
 * never echoes local config paths, tokens, or machine details.
 */
export declare function formatActiveGateRejection(conversationId: string, gate: ActiveGateResult): string;
/**
 * Open/switch/attach gate result for the active surface.
 *
 * Active open/switch/attach gate: allowed ONLY when every durable member is in
 * the injected local runnable set. A malformed member fails closed. Empty
 * durable membership is deterministic and openable (a draft has no members).
 *
 * `checkActiveGate`/`canOpenActive` and the exact UI/API action terms
 * (`inspect` vs `open as active`/`attach`/`switch`) follow below.
 */
export declare function checkActiveGate(durableMembers: readonly string[], runnableAgents: readonly string[]): ActiveGateResult;
/** Convenience predicate for the active switch/attach gate. */
export declare function canOpenActive(durableMembers: readonly string[], runnableAgents: readonly string[]): boolean;
/** Exact UI/API action terms from the architecture design (§8/§9). */
export type ConversationAction = "inspect" | "read-history" | "open-as-active" | "attach" | "switch";
/** `open as active` / `attach` / `switch` — the gated, activating actions. */
export declare function isActivatingAction(action: ConversationAction): boolean;
/** `inspect` / `read history` — always read-only, never activating. */
export declare function isReadOnlyInspectionAction(action: ConversationAction): boolean;
/**
 * Deterministic action predicate: read-only inspection is ALWAYS permitted
 * (it never activates the conversation and is never an authorization bypass);
 * activating actions are permitted only when the active gate passes.
 */
export declare function isActionPermitted(action: ConversationAction, durableMembers: readonly string[], runnableAgents: readonly string[]): boolean;
/** Deterministic first-occurrence dedupe preserving order. */
export declare function dedupePreservingOrder(names: readonly string[]): string[];
