/**
 * C3-A: stateless gateway attach gate — pure web core.
 *
 * The gateway's `POST /api/conversations/<id>/attach` route applies the
 * accepted C1 `checkActiveGate` against the local runnable set and returns
 * either an attached envelope (200) or a bounded rejected envelope (409).
 * This module decodes that response and resolves the presentation: an
 * attached conversation opens the ACTIVE surface (timeline + raw-text
 * composer + live SSE); a rejected conversation opens the visibly read-only
 * inspection surface (whole-history reread, no composer, no live stream).
 * The browser never re-derives the gate itself — it is server-authoritative
 * and stateless (no vault write, membership update, dispatch, or session).
 */
import { parseConversationRecord, type ConversationRecord } from "./conversations.js";
import type { RoomAgentEntry } from "./rooms.js";

export interface AttachGate {
  ok: boolean;
  missing: string[];
  malformed: string[];
}

export type AttachResponse =
  | { attached: true; conversation: ConversationRecord; gate: AttachGate }
  | { attached: false; error: string; gate: AttachGate };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseGate(json: unknown): AttachGate {
  if (!isRecord(json) || typeof json.ok !== "boolean" || !isStringArray(json.missing) || !isStringArray(json.malformed)) {
    throw new Error("unexpected attach gate");
  }
  return { ok: json.ok, missing: json.missing, malformed: json.malformed };
}

/** Fail-closed validation of POST /api/conversations/<id>/attach. */
export function parseAttachResponse(json: unknown): AttachResponse {
  if (!isRecord(json)) throw new Error("unexpected attach response");
  if (json.attached === true) {
    return { attached: true, conversation: parseConversationRecord(json.conversation), gate: parseGate(json.gate) };
  }
  if (json.attached === false) {
    if (typeof json.error !== "string" || json.error.trim() === "") {
      throw new Error("unexpected attach response");
    }
    return { attached: false, error: json.error.trim(), gate: parseGate(json.gate) };
  }
  throw new Error("unexpected attach response");
}

/** The two honest conversation presentations after an attach attempt. */
export type ConversationPresentation = "active" | "read-only";

/**
 * Attach presentation decision: the server-authoritative attach response
 * decides. Attached -> active (composer + live stream); rejected -> visibly
 * read-only inspection (history only, no composer, no live stream).
 */
export function resolveAttachPresentation(response: AttachResponse): ConversationPresentation {
  return response.attached ? "active" : "read-only";
}

export interface MemberRunnableStatus {
  name: string;
  runnable: boolean;
}

/**
 * Classify durable audience members against the local roster for truthful
 * labelling. `online` in the roster is local installation policy only; a
 * member is runnable exactly when the roster has it marked online. This is
 * presentation-only — the authoritative gate is the attach route.
 */
export function classifyAudienceMembers(audience: readonly string[], roster: readonly RoomAgentEntry[]): MemberRunnableStatus[] {
  const online = new Set(roster.filter((entry) => entry.online).map((entry) => entry.name));
  return audience.map((name) => ({ name, runnable: online.has(name) }));
}
