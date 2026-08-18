/**
 * T6 — browser-only Conversation telemetry parser/state core
 * (workbench-task-handoff-and-agent-telemetry-contract §§3.1–3.4).
 *
 * Strict, fail-closed parsing of the bounded T3 `conversation_telemetry` SSE
 * frame and the T4 scoped read response, plus an in-memory per-agent
 * session-only state core and a text-first display formatter. The bounded
 * schema is an allowlist: session ids/paths, token/cost totals, transcript
 * content, raw RPC objects, and error payloads are never accepted, stored,
 * or rendered. The three live context states (ok / post_compaction_pending /
 * no_window) and the explicit no_live_session read result stay distinct —
 * absence of information is never merged into a fabricated number. There is
 * no Conversation-wide context: every entry belongs to exactly one agent.
 */

export type ConversationContextState = "ok" | "post_compaction_pending" | "no_window";

export interface ConversationTelemetryContext {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ConversationTelemetryModel {
  provider?: string;
  id?: string;
}

/** Bounded browser-safe live facts (mirrors the T3/T4 gateway allowlist). */
export interface ConversationTelemetryLiveFacts {
  contextState: ConversationContextState;
  context?: ConversationTelemetryContext;
  model?: ConversationTelemetryModel;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
}

/** The bounded T3 live SSE frame for one exact conversation × agent run. */
export interface ConversationTelemetryFrame extends ConversationTelemetryLiveFacts {
  conversationId: string;
  agent: string;
  runId: string;
}

/** The bounded T4 scoped read result. */
export type ConversationTelemetryReadResult =
  | (ConversationTelemetryLiveFacts & { sessionState: "live" })
  | { sessionState: "no_live_session" };

export type ConversationTelemetryParseResult = { ok: true; frame: ConversationTelemetryFrame } | { ok: false; reason: string };

/**
 * One in-memory telemetry entry for one agent. `runId` is T3 correlation/
 * display-sequencing only; a T4 refresh entry carries no run correlation.
 */
export type ConversationTelemetryEntry =
  | { kind: "live"; agent: string; runId: string | null; facts: ConversationTelemetryLiveFacts }
  | { kind: "no-live"; agent: string };

/** Per-agent session-only state. Never persisted, never derived from history. */
export type ConversationTelemetryState = ReadonlyMap<string, ConversationTelemetryEntry>;

/**
 * Exact allowlists (recursive): any key outside these sets — including
 * raw/session/cost/error/transcript-shaped fields — rejects the whole
 * frame/response. Nothing unknown is parsed, stored, or rendered.
 */
const FRAME_KEYS: readonly string[] = ["conversationId", "agent", "runId", "contextState", "context", "model", "thinkingLevel", "autoCompactionEnabled"];
const LIVE_READ_KEYS: readonly string[] = ["sessionState", "contextState", "context", "model", "thinkingLevel", "autoCompactionEnabled"];
const CONTEXT_KEYS: readonly string[] = ["tokens", "contextWindow", "percent"];
const MODEL_KEYS: readonly string[] = ["provider", "id"];
const CONTEXT_STATES: readonly ConversationContextState[] = ["ok", "post_compaction_pending", "no_window"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 128;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

/** The first key outside the allowlist, or null when the record is exact. */
function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function parseContext(value: unknown): ConversationTelemetryContext | null {
  if (!isRecord(value)) return null;
  if (unknownKey(value, CONTEXT_KEYS) !== null) return null;
  if (!isFiniteNumber(value.contextWindow)) return null;
  if (!isNullableNumber(value.tokens) || !isNullableNumber(value.percent)) return null;
  return { tokens: value.tokens, contextWindow: value.contextWindow, percent: value.percent };
}

/** Validate bounded live facts; returns an error reason or null when valid. */
function validateFacts(record: Record<string, unknown>, allowedKeys: readonly string[]): ConversationTelemetryLiveFacts | null {
  if (unknownKey(record, allowedKeys) !== null) return null;
  const contextState = record.contextState;
  if (typeof contextState !== "string" || !CONTEXT_STATES.includes(contextState as ConversationContextState)) return null;
  const facts: ConversationTelemetryLiveFacts = { contextState: contextState as ConversationContextState };
  const hasContext = record.context !== undefined;
  const context = hasContext ? parseContext(record.context) : null;
  if (hasContext && context === null) return null;
  if (contextState === "ok") {
    if (context === null || context.tokens === null || context.percent === null) return null;
  } else if (contextState === "post_compaction_pending") {
    if (context === null || (context.tokens !== null && context.percent !== null)) return null;
  } else if (hasContext) {
    return null; // no_window never carries a context object
  }
  if (context !== null) facts.context = context;
  if (record.model !== undefined) {
    if (!isRecord(record.model)) return null;
    if (unknownKey(record.model, MODEL_KEYS) !== null) return null;
    const model: ConversationTelemetryModel = {};
    if (record.model.provider !== undefined) {
      if (!isBoundedString(record.model.provider)) return null;
      model.provider = record.model.provider;
    }
    if (record.model.id !== undefined) {
      if (!isBoundedString(record.model.id)) return null;
      model.id = record.model.id;
    }
    facts.model = model;
  }
  if (record.thinkingLevel !== undefined) {
    if (!isBoundedString(record.thinkingLevel)) return null;
    facts.thinkingLevel = record.thinkingLevel;
  }
  if (record.autoCompactionEnabled !== undefined) {
    if (typeof record.autoCompactionEnabled !== "boolean") return null;
    facts.autoCompactionEnabled = record.autoCompactionEnabled;
  }
  return facts;
}

/**
 * Strict fail-closed parser for one T3 `conversation_telemetry` frame. The
 * frame must name the SELECTED conversation, carry bounded agent/runId, and
 * validate as bounded facts; forbidden raw keys, malformed values, and state
 * inconsistencies reject without mutating any state.
 */
export function parseConversationTelemetryFrame(json: unknown, conversationId: string): ConversationTelemetryParseResult {
  if (!isRecord(json)) return { ok: false, reason: "not an object" };
  const unknown = unknownKey(json, FRAME_KEYS);
  if (unknown !== null) return { ok: false, reason: `unknown key: ${unknown}` };
  if (json.conversationId !== conversationId) return { ok: false, reason: "foreign conversation" };
  if (!isBoundedString(json.agent)) return { ok: false, reason: "invalid agent" };
  if (!isBoundedString(json.runId)) return { ok: false, reason: "invalid runId" };
  const facts = validateFacts(json, FRAME_KEYS);
  if (facts === null) return { ok: false, reason: "invalid facts" };
  return { ok: true, frame: { conversationId, agent: json.agent, runId: json.runId, ...facts } };
}

/**
 * Strict parser for the T4 scoped read response. Throws on any invalid or
 * leaking payload — a failed read never becomes an invented state.
 */
export function parseConversationTelemetryReadResponse(json: unknown): ConversationTelemetryReadResult {
  if (!isRecord(json)) throw new Error("unexpected telemetry response");
  if (json.sessionState === "no_live_session") {
    const extra = Object.keys(json).filter((key) => key !== "sessionState");
    if (extra.length > 0) throw new Error("unexpected telemetry response (no-live payload carries fields)");
    return { sessionState: "no_live_session" };
  }
  if (json.sessionState !== "live") throw new Error("unexpected telemetry response (sessionState)");
  const unknown = unknownKey(json, LIVE_READ_KEYS);
  if (unknown !== null) throw new Error(`unexpected telemetry response (unknown key: ${unknown})`);
  const facts = validateFacts(json, LIVE_READ_KEYS);
  if (facts === null) throw new Error("unexpected telemetry response (facts)");
  return { sessionState: "live", ...facts };
}

export function emptyConversationTelemetryState(): ConversationTelemetryState {
  return new Map();
}

/**
 * Apply one validated T3 frame: replaces ONLY the addressed agent's entry.
 * Never derives a Conversation-wide total from multiple entries.
 */
export function applyConversationTelemetryFrame(state: ConversationTelemetryState, frame: ConversationTelemetryFrame): ConversationTelemetryState {
  const next = new Map(state);
  const { conversationId: _cid, agent, runId, ...facts } = frame;
  next.set(agent, { kind: "live", agent, runId, facts });
  return next;
}

/**
 * Apply one validated T4 read result for the exact requested agent: a live
 * result replaces the entry (no run correlation); an explicit no_live_session
 * result records a truthful no-live entry (the ONLY way that state appears).
 */
export function applyConversationTelemetryRead(
  state: ConversationTelemetryState,
  agent: string,
  result: ConversationTelemetryReadResult,
): ConversationTelemetryState {
  const next = new Map(state);
  if (result.sessionState === "no_live_session") {
    next.set(agent, { kind: "no-live", agent });
    return next;
  }
  const { sessionState: _sessionState, ...facts } = result;
  next.set(agent, { kind: "live", agent, runId: null, facts });
  return next;
}

function formatTokenCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export interface ConversationTelemetryLine {
  text: string;
  ariaLabel: string;
}

/** Text-first display line for one entry. Never color-only; never a badge. */
export function formatConversationTelemetryEntry(entry: ConversationTelemetryEntry): ConversationTelemetryLine {
  if (entry.kind === "no-live") {
    return { text: `${entry.agent} · no live session`, ariaLabel: `${entry.agent}: no live session` };
  }
  const { facts } = entry;
  let base: string;
  let aria: string;
  if (facts.contextState === "ok" && facts.context !== undefined && facts.context.tokens !== null && facts.context.percent !== null) {
    base = `${entry.agent} · ${formatTokenCount(facts.context.tokens)} / ${formatTokenCount(facts.context.contextWindow)} context · ${facts.context.percent}%`;
    aria = `${entry.agent} context usage ${facts.context.percent} percent of ${formatTokenCount(facts.context.contextWindow)} token window`;
  } else if (facts.contextState === "post_compaction_pending") {
    base = `${entry.agent} · context usage temporarily unavailable after compaction`;
    aria = `${entry.agent}: context usage temporarily unavailable after compaction`;
  } else {
    base = `${entry.agent} · no context window information`;
    aria = `${entry.agent}: no context window information for this session`;
  }
  const suffixes: string[] = [];
  if (facts.autoCompactionEnabled !== undefined) suffixes.push(`auto-compaction ${facts.autoCompactionEnabled ? "on" : "off"}`);
  const provider = facts.model?.provider;
  const id = facts.model?.id;
  if (provider !== undefined || id !== undefined) suffixes.push([provider, id].filter((part) => part !== undefined).join("/"));
  if (facts.thinkingLevel !== undefined) suffixes.push(`thinking ${facts.thinkingLevel}`);
  const text = suffixes.length > 0 ? `${base} · ${suffixes.join(" · ")}` : base;
  return { text, ariaLabel: aria };
}
