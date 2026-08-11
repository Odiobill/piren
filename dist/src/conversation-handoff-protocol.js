import { CONVERSATION_HANDOFF_MAX_TEXT_LENGTH, CONVERSATION_HANDOFF_PROTOCOL_VERSION, parseConversationHandoffRequest, } from "./conversation-handoff.js";
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
export const CONVERSATION_HANDOFF_REQUEST_TITLE = "piren:conversation-handoff";
/**
 * The environment flag that activates the gated `conversation_handoff`
 * extension tool. The ConversationBroker sets it to exactly "root" (direct
 * steward-dispatched lead) or "workflow" (a child stage of an accepted edge)
 * ONLY on its own isolated Conversation run spawn targets; every other
 * process leaves it unset. The flag is broker-owned process capability, not
 * user config, public API input, or a global environment mutation.
 */
export const CONVERSATION_HANDOFF_ENABLED_ENV_VAR = "PIREN_CONVERSATION_HANDOFF_ENABLED";
/** The two exact broker-owned conversation handoff roles. */
export const CONVERSATION_HANDOFF_ROLES = ["root", "workflow"];
/**
 * Resolve the exact two-mode role from a spawn environment. Absent, empty,
 * malformed, or any other value (including room-style "1") yields null and
 * registers no tool.
 */
export function resolveConversationHandoffRole(env) {
    const value = env[CONVERSATION_HANDOFF_ENABLED_ENV_VAR];
    if (value === "root" || value === "workflow")
        return value;
    return null;
}
/**
 * Fast structural discriminator: is this Pi event a reserved conversation
 * handoff control request? Only the title discriminates; the placeholder is
 * parsed separately by {@link parseConversationHandoffInputRequest}. A
 * version mismatch is still a handoff request (answered with a bounded
 * rejection, never leaked into approvals).
 */
export function isConversationHandoffInputRequest(event) {
    return (event.type === "extension_ui_request" &&
        event.method === "input" &&
        event.title === CONVERSATION_HANDOFF_REQUEST_TITLE);
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse and validate the reserved conversation handoff request envelope
 * (reusing the C5-1 bounded `{to,text}` validation). Returns a deterministic
 * non-secret reason for every malformed/version/size case and never throws.
 */
export function parseConversationHandoffInputRequest(event) {
    const placeholder = event.placeholder;
    if (typeof placeholder !== "string" || placeholder === "") {
        return { ok: false, reason: "conversation handoff request placeholder is missing" };
    }
    let payload;
    try {
        payload = JSON.parse(placeholder);
    }
    catch {
        return { ok: false, reason: "conversation handoff request placeholder is not valid JSON" };
    }
    if (!isPlainObject(payload)) {
        return { ok: false, reason: "conversation handoff request placeholder is not a JSON object" };
    }
    const parsed = parseConversationHandoffRequest(payload);
    if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
    }
    return { ok: true, to: parsed.request.to, text: parsed.request.text };
}
/**
 * Render the versioned request placeholder carried by the reserved input
 * envelope. It carries ONLY `to` and `text` (plus the protocol version);
 * callers can never supply a conversation id, source identity, root
 * correlation, budget, or role through the envelope. Assumes the args were
 * already validated by {@link validateConversationHandoffArgs}.
 */
export function renderConversationHandoffRequestPlaceholder(to, text) {
    return JSON.stringify({ v: CONVERSATION_HANDOFF_PROTOCOL_VERSION, to, text });
}
/**
 * Validate `conversation_handoff(to, text)` arguments BEFORE any UI
 * operation. Returns a deterministic non-secret error string, or null when
 * valid.
 */
export function validateConversationHandoffArgs(to, text) {
    if (typeof to !== "string" || to === "" || !/^[a-z][a-z0-9-]*$/.test(to)) {
        return "conversation_handoff 'to' must be a valid lowercase kebab-case agent name";
    }
    if (typeof text !== "string" || text.trim() === "") {
        return "conversation_handoff 'text' must be non-blank";
    }
    if (text.length > CONVERSATION_HANDOFF_MAX_TEXT_LENGTH) {
        return "conversation_handoff 'text' exceeds the maximum length";
    }
    return null;
}
/**
 * Bounded results returned to the tool call. A root gate is held until the
 * steward settles it, then returns `ok` or `rejected`; a workflow accept
 * returns `ok` immediately; every other bounded failure returns `rejected`.
 */
export const CONVERSATION_HANDOFF_RESULT_STATUSES = ["pending", "ok", "rejected"];
/** Render the bounded result into the JSON string carried by the input response `value`. */
export function renderConversationHandoffResultValue(result) {
    const payload = { v: CONVERSATION_HANDOFF_PROTOCOL_VERSION, status: result.status };
    if (result.status === "rejected") {
        payload.reason = result.reason;
    }
    return JSON.stringify(payload);
}
/**
 * Parse a rendered result value back into the typed result. Used by the
 * extension to convert only a valid, matching result into the tool result.
 * Returns a deterministic reason for every malformed shape.
 */
export function parseConversationHandoffResultValue(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return { ok: false, reason: "conversation handoff result value is not valid JSON" };
    }
    if (!isPlainObject(parsed)) {
        return { ok: false, reason: "conversation handoff result value is not a JSON object" };
    }
    if (parsed.v !== CONVERSATION_HANDOFF_PROTOCOL_VERSION) {
        return { ok: false, reason: "conversation handoff result version mismatch" };
    }
    const status = parsed.status;
    if (typeof status !== "string" || !CONVERSATION_HANDOFF_RESULT_STATUSES.includes(status)) {
        return { ok: false, reason: "conversation handoff result status is unknown" };
    }
    if (status === "rejected") {
        if (typeof parsed.reason !== "string") {
            return { ok: false, reason: "conversation handoff result rejected status requires a reason" };
        }
        return { ok: true, version: CONVERSATION_HANDOFF_PROTOCOL_VERSION, result: { status: "rejected", reason: parsed.reason } };
    }
    return { ok: true, version: CONVERSATION_HANDOFF_PROTOCOL_VERSION, result: { status } };
}
/**
 * Map a raw `ctx.ui.input()` response value to a bounded
 * `conversation_handoff` tool outcome. `pending` and `ok` yield fixed
 * non-secret replies; every cancelled, no-value, malformed,
 * version-mismatched, or rejected response becomes an explicit bounded
 * non-secret error with NO fallback action and NO retry. Never exposes
 * conversation ids, internal event ids, or broker reasons.
 */
export function resolveConversationHandoffToolResult(value) {
    if (value === undefined || value === null) {
        return { ok: false, error: "conversation handoff was cancelled" };
    }
    const parsed = parseConversationHandoffResultValue(value);
    if (!parsed.ok) {
        return { ok: false, error: `conversation handoff result was not understood (${parsed.reason})` };
    }
    switch (parsed.result.status) {
        case "pending":
            // Backward-compatible parser support for a pre-fix broker response.
            // New root gates stay held and settle as `ok` or `rejected`.
            return { ok: true, reply: "Conversation handoff gate requested; awaiting steward approval." };
        case "ok":
            return { ok: true, reply: "Conversation handoff accepted; the child stage will launch after this run completes." };
        case "rejected":
            // Fixed bounded non-secret error. The broker's reason is NEVER
            // interpolated into the tool result (no internal ids/reasons leak).
            return { ok: false, error: "conversation handoff was rejected by the conversation broker" };
    }
}
/**
 * Decorate a conversation run spawn target with the gated handoff role flag
 * (C5-3). Returns a NEW target object with a NEW env object: every existing
 * entry is preserved, the input target and its env are never mutated, and
 * the global `process.env` is never touched. Only the broker's isolated
 * Conversation run targets receive the flag; ordinary gateway/transport/ask/
 * worker/review/room processes do not.
 */
export function decorateConversationClientTarget(target, role) {
    return {
        ...target,
        env: {
            ...target.env,
            [CONVERSATION_HANDOFF_ENABLED_ENV_VAR]: role,
        },
    };
}
//# sourceMappingURL=conversation-handoff-protocol.js.map