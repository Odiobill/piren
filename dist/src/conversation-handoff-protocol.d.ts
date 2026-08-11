import type { RpcEvent, RpcSpawnTarget } from "./gateway-rpc.js";
/**
 * C5-3 — pure reserved Pi `extension_ui_request` / `input` control protocol
 * bridging the gated `conversation_handoff(to, text)` extension tool to the
 * ConversationBroker (room R2 transport precedent, conversation semantics).
 *
 * The broker cannot be imported by a conversation-run Pi extension, so a
 * bounded conversation handoff rides on Pi's documented
 * `extension_ui_request` / `method: input` round trip. The extension emits
 * one reserved, versioned input envelope; the broker intercepts it only from
 * its exact active C5 run, performs the bounded root-gate or workflow-accept
 * decision, and answers the same request id with a structured `value` result.
 * Unlike the blocking room R2 parent/child handoff, the conversation control
 * waits only for the steward's initial gate: the root input stays pending
 * until confirmation/cancellation, then returns `ok` or `rejected`. A
 * workflow accept returns `ok` immediately; every child still launches later,
 * sequentially, only after the source terminal.
 *
 * The reserved {@link CONVERSATION_HANDOFF_REQUEST_TITLE} is a protocol
 * discriminator, NOT an authorization secret. Authoritative source identity
 * comes only from the broker's active run; callers can never supply a
 * conversation id, source identity, root correlation, budget, or role through
 * the envelope. This module is pure: no filesystem, no network, no Pi auth.
 */
/** The exact reserved `input` request title for conversation handoff controls. */
export declare const CONVERSATION_HANDOFF_REQUEST_TITLE = "piren:conversation-handoff";
/**
 * The environment flag that activates the gated `conversation_handoff`
 * extension tool. The ConversationBroker sets it to exactly "root" (direct
 * steward-dispatched lead) or "workflow" (a child stage of an accepted edge)
 * ONLY on its own isolated Conversation run spawn targets; every other
 * process leaves it unset. The flag is broker-owned process capability, not
 * user config, public API input, or a global environment mutation.
 */
export declare const CONVERSATION_HANDOFF_ENABLED_ENV_VAR = "PIREN_CONVERSATION_HANDOFF_ENABLED";
/** The two exact broker-owned conversation handoff roles. */
export declare const CONVERSATION_HANDOFF_ROLES: readonly ["root", "workflow"];
export type ConversationHandoffRole = (typeof CONVERSATION_HANDOFF_ROLES)[number];
/**
 * Resolve the exact two-mode role from a spawn environment. Absent, empty,
 * malformed, or any other value (including room-style "1") yields null and
 * registers no tool.
 */
export declare function resolveConversationHandoffRole(env: Record<string, string | undefined>): ConversationHandoffRole | null;
/**
 * Fast structural discriminator: is this Pi event a reserved conversation
 * handoff control request? Only the title discriminates; the placeholder is
 * parsed separately by {@link parseConversationHandoffInputRequest}. A
 * version mismatch is still a handoff request (answered with a bounded
 * rejection, never leaked into approvals).
 */
export declare function isConversationHandoffInputRequest(event: RpcEvent): boolean;
/** Outcome of parsing a reserved conversation handoff input request envelope. */
export type ConversationHandoffInputParse = {
    ok: true;
    to: string;
    text: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse and validate the reserved conversation handoff request envelope
 * (reusing the C5-1 bounded `{to,text}` validation). Returns a deterministic
 * non-secret reason for every malformed/version/size case and never throws.
 */
export declare function parseConversationHandoffInputRequest(event: RpcEvent): ConversationHandoffInputParse;
/**
 * Render the versioned request placeholder carried by the reserved input
 * envelope. It carries ONLY `to` and `text` (plus the protocol version);
 * callers can never supply a conversation id, source identity, root
 * correlation, budget, or role through the envelope. Assumes the args were
 * already validated by {@link validateConversationHandoffArgs}.
 */
export declare function renderConversationHandoffRequestPlaceholder(to: string, text: string): string;
/**
 * Validate `conversation_handoff(to, text)` arguments BEFORE any UI
 * operation. Returns a deterministic non-secret error string, or null when
 * valid.
 */
export declare function validateConversationHandoffArgs(to: string, text: string): string | null;
/**
 * Bounded results returned to the tool call. A root gate is held until the
 * steward settles it, then returns `ok` or `rejected`; a workflow accept
 * returns `ok` immediately; every other bounded failure returns `rejected`.
 */
export declare const CONVERSATION_HANDOFF_RESULT_STATUSES: readonly ["pending", "ok", "rejected"];
export type ConversationHandoffResultStatus = (typeof CONVERSATION_HANDOFF_RESULT_STATUSES)[number];
/** The bounded, non-secret result rendered into the input response `value`. */
export type ConversationHandoffControlResult = {
    status: "pending";
} | {
    status: "ok";
} | {
    status: "rejected";
    reason: string;
};
/** Render the bounded result into the JSON string carried by the input response `value`. */
export declare function renderConversationHandoffResultValue(result: ConversationHandoffControlResult): string;
/** Outcome of parsing a rendered conversation handoff result value (extension side). */
export type ConversationHandoffResultParse = {
    ok: true;
    version: number;
    result: ConversationHandoffControlResult;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse a rendered result value back into the typed result. Used by the
 * extension to convert only a valid, matching result into the tool result.
 * Returns a deterministic reason for every malformed shape.
 */
export declare function parseConversationHandoffResultValue(value: string): ConversationHandoffResultParse;
/** Outcome of mapping a raw input response value to a conversation_handoff tool result. */
export type ConversationHandoffToolOutcome = {
    ok: true;
    reply: string;
} | {
    ok: false;
    error: string;
};
/**
 * Map a raw `ctx.ui.input()` response value to a bounded
 * `conversation_handoff` tool outcome. `pending` and `ok` yield fixed
 * non-secret replies; every cancelled, no-value, malformed,
 * version-mismatched, or rejected response becomes an explicit bounded
 * non-secret error with NO fallback action and NO retry. Never exposes
 * conversation ids, internal event ids, or broker reasons.
 */
export declare function resolveConversationHandoffToolResult(value: string | undefined | null): ConversationHandoffToolOutcome;
/**
 * Decorate a conversation run spawn target with the gated handoff role flag
 * (C5-3). Returns a NEW target object with a NEW env object: every existing
 * entry is preserved, the input target and its env are never mutated, and
 * the global `process.env` is never touched. Only the broker's isolated
 * Conversation run targets receive the flag; ordinary gateway/transport/ask/
 * worker/review/room processes do not.
 */
export declare function decorateConversationClientTarget(target: RpcSpawnTarget, role: ConversationHandoffRole): RpcSpawnTarget;
