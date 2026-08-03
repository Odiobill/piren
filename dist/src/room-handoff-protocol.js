import { isValidAgentName, ROOM_RUN_FAILURE_KINDS } from "./rooms.js";
/**
 * Pure room-handoff control-plane protocol (ADR-0041 R2a).
 *
 * The broker cannot be imported by a room-run Pi extension, so an accepted
 * agent-to-agent handoff rides on Pi's documented `extension_ui_request` /
 * `method: input` round trip. The extension (R2b) emits one reserved,
 * versioned input envelope; the broker intercepts it only from its exact
 * active parent run, performs the bounded child dispatch, and answers the
 * same request id with a structured `value` result.
 *
 * The reserved {@link ROOM_HANDOFF_REQUEST_TITLE} is a protocol
 * discriminator, NOT an authorization secret. Authoritative source identity
 * comes only from the broker's active parent run. Callers can never supply a
 * room id, source identity, root correlation, budget, or capability through
 * the envelope; those are derived entirely from the broker's run state.
 *
 * This module is pure: no filesystem, no network, no Pi auth. It only parses
 * and renders the wire shapes deterministically.
 */
/** Wire protocol version. Bump only on an incompatible envelope change. */
export const ROOM_HANDOFF_PROTOCOL_VERSION = 1;
/**
 * The exact reserved `input` request title. Any `extension_ui_request` with
 * `method: input` and exactly this title is a handoff control request; every
 * other input request is an ordinary approval.
 */
export const ROOM_HANDOFF_REQUEST_TITLE = "piren:room-handoff";
/** Fixed maximum request text length (characters). Deliberately tiny. */
export const ROOM_HANDOFF_MAX_TEXT_LENGTH = 4000;
/** Fixed maximum worker reply length returned in an `ok` control result. */
export const ROOM_HANDOFF_MAX_REPLY_LENGTH = 4000;
/**
 * Explicit non-secret marker appended by the broker when a worker reply is
 * truncated to {@link ROOM_HANDOFF_MAX_REPLY_LENGTH}. The immutable worker
 * evidence is never altered; only the control-plane result is bounded.
 */
export const ROOM_HANDOFF_TRUNCATION_MARKER = "\n…[reply truncated]";
/** Bounded result statuses returned to the lead's waiting tool call. */
export const ROOM_HANDOFF_RESULT_STATUSES = ["ok", "rejected", "failed", "timed_out", "cancelled"];
/**
 * Fast structural discriminator: is this Pi event a reserved handoff control
 * request? Only the title discriminates; the placeholder is parsed separately
 * by {@link parseHandoffInputRequest}. A version mismatch is still a handoff
 * request (it is answered with a bounded rejection, never leaked to approvals).
 */
export function isHandoffInputRequest(event) {
    return (event.type === "extension_ui_request" &&
        event.method === "input" &&
        event.title === ROOM_HANDOFF_REQUEST_TITLE);
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse and validate the reserved handoff request envelope. Returns a
 * deterministic non-secret reason for every malformed/version/size case. The
 * caller is expected to have matched the reserved title first, but this is
 * tolerant of any event and never throws.
 */
export function parseHandoffInputRequest(event) {
    const placeholder = event.placeholder;
    if (typeof placeholder !== "string" || placeholder === "") {
        return { ok: false, reason: "handoff request placeholder is missing" };
    }
    let payload;
    try {
        payload = JSON.parse(placeholder);
    }
    catch {
        return { ok: false, reason: "handoff request placeholder is not valid JSON" };
    }
    if (!isPlainObject(payload)) {
        return { ok: false, reason: "handoff request placeholder is not a JSON object" };
    }
    if (payload.v !== ROOM_HANDOFF_PROTOCOL_VERSION) {
        return { ok: false, reason: `handoff request version mismatch: expected ${ROOM_HANDOFF_PROTOCOL_VERSION}` };
    }
    const to = payload.to;
    if (typeof to !== "string" || to === "" || !isValidAgentName(to)) {
        return { ok: false, reason: "handoff request target is not a valid agent name" };
    }
    const text = payload.text;
    if (typeof text !== "string" || text.trim() === "") {
        return { ok: false, reason: "handoff request text is blank" };
    }
    if (text.length > ROOM_HANDOFF_MAX_TEXT_LENGTH) {
        return { ok: false, reason: "handoff request text exceeds the maximum length" };
    }
    return { ok: true, version: ROOM_HANDOFF_PROTOCOL_VERSION, to, text };
}
/**
 * Render the bounded result into the JSON string carried by the input
 * response `value`. Optional fields are emitted only for their status.
 */
export function renderHandoffResultValue(result) {
    const payload = { v: ROOM_HANDOFF_PROTOCOL_VERSION, status: result.status };
    if (result.status === "ok") {
        payload.reply = result.reply;
    }
    else if (result.status === "rejected") {
        payload.reason = result.reason;
    }
    else if (result.status === "failed") {
        payload.reason = result.reason;
        payload.failureKind = result.failureKind;
    }
    return JSON.stringify(payload);
}
/**
 * The environment flag that activates the gated `room_mention` extension
 * tool. The RoomBroker sets it to "1" only on its spawned room-client targets
 * (root leads and handoff workers); every other process leaves it unset.
 */
export const ROOM_MENTION_ENABLED_ENV_VAR = "PIREN_ROOM_MENTION_ENABLED";
/** True only when the activation flag is exactly the enabled value "1". */
export function isRoomMentionEnabled(env) {
    return env[ROOM_MENTION_ENABLED_ENV_VAR] === "1";
}
/**
 * Render the versioned request placeholder carried by the reserved input
 * envelope. It carries ONLY `to` and `text` (plus the protocol version);
 * callers can never supply a room id, source identity, root correlation,
 * budget, or capability through the envelope. Assumes the args were already
 * validated by {@link validateRoomMentionArgs}.
 */
export function renderHandoffRequestPlaceholder(to, text) {
    return JSON.stringify({ v: ROOM_HANDOFF_PROTOCOL_VERSION, to, text });
}
/**
 * Validate `room_mention(to, text)` arguments BEFORE any UI operation.
 * Returns a deterministic non-secret error string, or null when valid.
 */
export function validateRoomMentionArgs(to, text) {
    if (!isValidAgentName(to)) {
        return "room_mention 'to' must be a valid lowercase kebab-case agent name";
    }
    if (typeof text !== "string" || text.trim() === "") {
        return "room_mention 'text' must be non-blank";
    }
    if (text.length > ROOM_HANDOFF_MAX_TEXT_LENGTH) {
        return "room_mention 'text' exceeds the maximum length";
    }
    return null;
}
/**
 * Map a raw `ctx.ui.input()` response value to a bounded `room_mention` tool
 * outcome. Only a valid `ok` result yields the bounded worker reply. Every
 * cancelled, no-value, malformed, version-mismatched, rejected, failed,
 * timed_out, or cancelled-status reply becomes an explicit bounded non-secret
 * error with NO fallback action. Never exposes room ids, internal event ids,
 * or failure exceptions.
 */
export function resolveRoomMentionToolResult(value) {
    if (value === undefined || value === null) {
        return { ok: false, error: "room mention was cancelled" };
    }
    const parsed = parseHandoffResultValue(value);
    if (!parsed.ok) {
        return { ok: false, error: `room mention result was not understood (${parsed.reason})` };
    }
    const result = parsed.result;
    switch (result.status) {
        case "ok":
            return { ok: true, reply: result.reply };
        case "rejected":
            // Fixed bounded non-secret error. The broker's authorization reason may
            // legitimately embed the room id (for example "a run is already active
            // for room '<id>'"), and R2b forbids exposing room/internal ids through
            // the tool, so the broker-provided reason is NEVER interpolated.
            return { ok: false, error: "room mention was rejected by the room broker" };
        case "failed":
            // failureKind is a fixed enum (launch_failure | ambiguous), never an id.
            return { ok: false, error: `room mention failed (${result.failureKind})` };
        case "timed_out":
            return { ok: false, error: "room mention timed out" };
        case "cancelled":
            return { ok: false, error: "room mention was cancelled" };
    }
}
/**
 * Deterministically bound a worker reply for the control-plane `ok` result.
 * A reply within the cap is returned unchanged; an oversized reply is cut to
 * fit the cap WITH the explicit non-secret truncation marker appended, so the
 * rendered value always passes {@link parseHandoffResultValue}. The immutable
 * worker evidence is never touched by this helper.
 */
export function truncateHandoffReply(reply) {
    if (reply.length <= ROOM_HANDOFF_MAX_REPLY_LENGTH) {
        return reply;
    }
    return reply.slice(0, ROOM_HANDOFF_MAX_REPLY_LENGTH - ROOM_HANDOFF_TRUNCATION_MARKER.length) + ROOM_HANDOFF_TRUNCATION_MARKER;
}
/**
 * Parse a rendered result value back into the typed result. Used by the
 * extension (R2b) to convert only a valid, matching result into the tool
 * result. Returns a deterministic reason for every malformed shape.
 */
export function parseHandoffResultValue(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return { ok: false, reason: "handoff result value is not valid JSON" };
    }
    if (!isPlainObject(parsed)) {
        return { ok: false, reason: "handoff result value is not a JSON object" };
    }
    if (parsed.v !== ROOM_HANDOFF_PROTOCOL_VERSION) {
        return { ok: false, reason: "handoff result version mismatch" };
    }
    const status = parsed.status;
    if (typeof status !== "string" || !ROOM_HANDOFF_RESULT_STATUSES.includes(status)) {
        return { ok: false, reason: "handoff result status is unknown" };
    }
    if (status === "ok") {
        if (typeof parsed.reply !== "string") {
            return { ok: false, reason: "handoff result ok status requires a reply string" };
        }
        if (parsed.reply.length > ROOM_HANDOFF_MAX_REPLY_LENGTH) {
            return { ok: false, reason: "handoff result ok reply exceeds the maximum length" };
        }
        return { ok: true, version: ROOM_HANDOFF_PROTOCOL_VERSION, result: { status: "ok", reply: parsed.reply } };
    }
    if (status === "rejected") {
        if (typeof parsed.reason !== "string") {
            return { ok: false, reason: "handoff result rejected status requires a reason" };
        }
        return { ok: true, version: ROOM_HANDOFF_PROTOCOL_VERSION, result: { status: "rejected", reason: parsed.reason } };
    }
    if (status === "failed") {
        if (typeof parsed.reason !== "string") {
            return { ok: false, reason: "handoff result failed status requires a reason" };
        }
        if (typeof parsed.failureKind !== "string" || !ROOM_RUN_FAILURE_KINDS.includes(parsed.failureKind)) {
            return { ok: false, reason: "handoff result failed status requires a valid failureKind" };
        }
        return {
            ok: true,
            version: ROOM_HANDOFF_PROTOCOL_VERSION,
            result: { status: "failed", reason: parsed.reason, failureKind: parsed.failureKind },
        };
    }
    // timed_out | cancelled carry no extra fields.
    return { ok: true, version: ROOM_HANDOFF_PROTOCOL_VERSION, result: { status } };
}
//# sourceMappingURL=room-handoff-protocol.js.map