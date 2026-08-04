/**
 * Structured room dispatch composer core (ADR-0041 R3b-4 / W1).
 *
 * Framework-free pure helpers for the Rooms-module composer: request mapping
 * to the accepted structured `{agent, text}` body, send-enable validation
 * against the selected room's immutable participant record, and fail-closed
 * parsing of the `POST /api/rooms/<id>/messages` response. The UI never
 * infers an agent from rendered `@text`, never invents events/retries/queues/
 * synthetic run status, and never reads or persists tokens.
 */

/** The structured dispatch request body accepted by POST /api/rooms/<id>/messages. */
export interface RoomMessageRequest {
  agent: string;
  text: string;
}

export type RoomDispatchStatus = "completed" | "failed" | "timed_out" | "cancelled";

/** The documented dispatch outcome envelope (fail-closed parsed). */
export interface RoomDispatchOutcome {
  status: RoomDispatchStatus;
  roomId: string;
  agent: string;
  stewardEventId: string;
  terminalEventId: string;
  agentEventId?: string;
  failureKind?: string;
}

export type ComposerValidation =
  | { ok: true }
  | { ok: false; reason: "no participants" | "select a participant" | "not a participant" | "text required" };

export interface ValidateComposerInput {
  participants: string[];
  selectedAgent: string;
  text: string;
}

/**
 * Send-enable gate: a participant must be selected from the room's immutable
 * participant record and the trimmed text must be non-empty. The target agent
 * NEVER comes from text content.
 */
export function validateComposerInput(input: ValidateComposerInput): ComposerValidation {
  if (input.participants.length === 0) {
    return { ok: false, reason: "no participants" };
  }
  if (input.selectedAgent === "") {
    return { ok: false, reason: "select a participant" };
  }
  if (!input.participants.includes(input.selectedAgent)) {
    return { ok: false, reason: "not a participant" };
  }
  if (input.text.trim() === "") {
    return { ok: false, reason: "text required" };
  }
  return { ok: true };
}

/** Build the structured request body with trimmed text. */
export function toMessageRequest(agent: string, text: string): RoomMessageRequest {
  return { agent, text: text.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const DISPATCH_STATUSES: readonly string[] = ["completed", "failed", "timed_out", "cancelled"];

/**
 * Fail-closed parse of the `{outcome: ...}` envelope. Throws on any missing,
 * malformed, or unknown field so the UI never trusts a synthetic shape.
 */
export function parseDispatchOutcome(json: unknown): RoomDispatchOutcome {
  if (!isRecord(json) || !isRecord(json.outcome)) {
    throw new Error("unexpected /api/rooms/<id>/messages response");
  }
  const outcome = json.outcome as Record<string, unknown>;
  const status = outcome.status;
  if (typeof status !== "string" || !DISPATCH_STATUSES.includes(status)) {
    throw new Error("unexpected dispatch outcome status");
  }
  const roomId = asNonEmptyString(outcome.roomId);
  const agent = asNonEmptyString(outcome.agent);
  const stewardEventId = asNonEmptyString(outcome.stewardEventId);
  const terminalEventId = asNonEmptyString(outcome.terminalEventId);
  if (roomId === null || agent === null || stewardEventId === null || terminalEventId === null) {
    throw new Error("unexpected dispatch outcome fields");
  }
  const parsed: RoomDispatchOutcome = {
    status: status as RoomDispatchStatus,
    roomId,
    agent,
    stewardEventId,
    terminalEventId,
  };
  // exactOptionalPropertyTypes: assign optional fields only when defined.
  if (typeof outcome.agentEventId === "string" && outcome.agentEventId !== "") {
    parsed.agentEventId = outcome.agentEventId;
  }
  if (typeof outcome.failureKind === "string" && outcome.failureKind !== "") {
    parsed.failureKind = outcome.failureKind;
  }
  return parsed;
}

/**
 * Extract a non-secret server error string from a JSON error envelope, or
 * null when the payload is not a plain `{error: string}` shape. The caller
 * falls back to the HTTP status; raw server internals never reach the UI.
 */
export function parseMessageError(json: unknown): string | null {
  if (!isRecord(json) || typeof json.error !== "string" || json.error.trim() === "") {
    return null;
  }
  return json.error.trim();
}
