/**
 * U4 — broker-authoritative live activity web core (accepted
 * `conversation-live-activity-contract.md`).
 *
 * Strict fail-closed parsing of the additive `conversation_activity` SSE
 * frame, a per-run transient state machine (`working` → `typing` → cleared
 * by `settled`), bounded partial-reply accumulation with a truthful
 * truncation marker, and durable reconciliation (a correlated durable
 * `agent_message` replaces the transient partial; a durable terminal with
 * `runAgent` clears it). Activity is display-only: it is never durable, never
 * replayed from history, never reconstructed from `run_started`, and never
 * promoted to a timeline record. The truthful vocabulary is limited to
 * `<agent> is working…` / `<agent> is typing…` — there is no read/seen/
 * delivery-to-model claim.
 */
import type { ConversationEventRecord } from "./conversations.js";

export type ConversationActivityKind = "working" | "text_delta" | "settled" | "tool";
export type ConversationActivityOutcome = "completed" | "failed" | "timed_out" | "cancelled";
/** VR-3: exact bounded tool statuses on a `tool` activity frame. */
export type ConversationToolStatus = "started" | "completed" | "failed";

export interface ConversationActivityFrame {
  conversationId: string;
  runId: string;
  agent: string;
  kind: ConversationActivityKind;
  /** text_delta only: exact non-empty bounded Pi assistant delta. */
  delta?: string;
  /** settled only: terminal outcome after the durable terminal append. */
  outcome?: ConversationActivityOutcome;
  /** tool only: sanitized bounded Pi tool name. */
  toolName?: string;
  /** tool only: exact lifecycle status. */
  status?: ConversationToolStatus;
}

/** U4: bounded live-frame delta and transient partial-reply limits. */
export const CONVERSATION_ACTIVITY_DELTA_MAX = 4096;
export const CONVERSATION_ACTIVITY_PARTIAL_MAX = 16384;
/** U4: bounded in-memory settled-run tombstones (delayed stale frames are ignored). */
export const CONVERSATION_ACTIVITY_SETTLED_TOMBSTONES_MAX = 32;

/**
 * VR-3 — closed work-card rendering bounds. Assistant text is RETAINED up to
 * WORK_CARD_TEXT_RETENTION_MAX characters (rolling: the most recent content
 * survives) and RENDERED only as the most recent WORK_CARD_TAIL_RENDER_MAX
 * characters prefixed by exactly one leading ellipsis when truncated. At most
 * WORK_CARD_TOOLS_MAX most-recent sanitized tool lines are retained/rendered.
 */
export const WORK_CARD_TEXT_RETENTION_MAX = 2000;
export const WORK_CARD_TAIL_RENDER_MAX = 400;
export const WORK_CARD_TOOLS_MAX = 5;
/** VR-3: a tool frame name must already be exactly this shape (no stripping). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9 _:-]{1,80}$/;
const TOOL_STATUSES: readonly ConversationToolStatus[] = ["started", "completed", "failed"];

const ACTIVITY_OUTCOMES: readonly ConversationActivityOutcome[] = ["completed", "failed", "timed_out", "cancelled"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 128;
}

export type ConversationActivityParseResult =
  | { ok: true; frame: ConversationActivityFrame }
  | { ok: false; reason: string };

/**
 * Strict fail-closed frame parser: the frame must name the SELECTED
 * conversation, carry bounded runId/agent, an allowed kind, and the
 * kind-specific fields (working: neither delta nor outcome; text_delta:
 * non-empty bounded delta only; settled: an allowed outcome only). Unknown
 * keys are ignored for forward compatibility, but any violation clears/
 * ignores transient state and never becomes a timeline record.
 */
export function parseConversationActivityFrame(json: unknown, conversationId: string): ConversationActivityParseResult {
  if (!isRecord(json)) return { ok: false, reason: "not an object" };
  if (json.conversationId !== conversationId) return { ok: false, reason: "foreign conversation" };
  if (!isBoundedString(json.runId)) return { ok: false, reason: "invalid runId" };
  if (!isBoundedString(json.agent)) return { ok: false, reason: "invalid agent" };
  const kind = json.kind;
  if (kind !== "working" && kind !== "text_delta" && kind !== "settled" && kind !== "tool") {
    return { ok: false, reason: "unknown kind" };
  }
  if (kind === "working") {
    if (json.delta !== undefined || json.outcome !== undefined) {
      return { ok: false, reason: "working carries no delta/outcome" };
    }
    return { ok: true, frame: { conversationId, runId: json.runId, agent: json.agent, kind } };
  }
  if (kind === "tool") {
    if (json.delta !== undefined || json.outcome !== undefined) {
      return { ok: false, reason: "tool carries no delta/outcome" };
    }
    // Closed own-key schema: a tool frame may carry EXACTLY the six own
    // keys — any additional/unknown own field (arbitrary scalars, nested
    // details, or raw result/output aliases) fails closed.
    const allowedKeys = ["conversationId", "runId", "agent", "kind", "toolName", "status"];
    for (const key of Object.keys(json)) {
      if (!allowedKeys.includes(key)) return { ok: false, reason: `unknown tool field ${key}` };
    }
    const toolName = json.toolName;
    if (typeof toolName !== "string" || !TOOL_NAME_PATTERN.test(toolName)) {
      return { ok: false, reason: "invalid toolName" };
    }
    const status = json.status;
    if (typeof status !== "string" || !(TOOL_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, reason: "invalid tool status" };
    }
    return { ok: true, frame: { conversationId, runId: json.runId, agent: json.agent, kind, toolName, status: status as ConversationToolStatus } };
  }
  if (kind === "text_delta") {
    if (json.outcome !== undefined) return { ok: false, reason: "text_delta carries no outcome" };
    const delta = json.delta;
    if (typeof delta !== "string" || delta === "") return { ok: false, reason: "delta required non-empty" };
    if (delta.length > CONVERSATION_ACTIVITY_DELTA_MAX) return { ok: false, reason: "delta too long" };
    return { ok: true, frame: { conversationId, runId: json.runId, agent: json.agent, kind, delta } };
  }
  // settled
  if (json.delta !== undefined) return { ok: false, reason: "settled carries no delta" };
  const outcome = json.outcome;
  const outcomeValue = typeof outcome === "string" && (ACTIVITY_OUTCOMES as readonly string[]).includes(outcome) ? (outcome as ConversationActivityOutcome) : null;
  if (outcomeValue === null) {
    return { ok: false, reason: "invalid outcome" };
  }
  return { ok: true, frame: { conversationId, runId: json.runId, agent: json.agent, kind, outcome: outcomeValue } };
}

export interface ConversationActivityRun {
  runId: string;
  agent: string;
  phase: "working" | "typing";
  /** Accumulated exact live deltas, bounded; excess is never fabricated/persisted. */
  partial: string;
  truncated: boolean;
  /** VR-3: at most WORK_CARD_TOOLS_MAX most-recent sanitized tool lines. */
  tools: ConversationToolLine[];
}

/** VR-3: one retained safe tool line (sanitized name + exact status only). */
export interface ConversationToolLine {
  name: string;
  status: ConversationToolStatus;
}

export interface ConversationActivityState {
  runs: ConversationActivityRun[];
  /**
   * Bounded in-memory settled-run tombstones (runIds). A delayed
   * working/text_delta frame for a settled run is stale and is ignored, so
   * it can never resurrect display state. Cleared together with the rest of
   * the transient state on history reread/selection/stream end — never
   * stored or durable.
   */
  settled: string[];
}

export function emptyConversationActivity(): ConversationActivityState {
  return { runs: [], settled: [] };
}

/**
 * R2 — the compact, source-truthful live state surfaced to the bottom dock:
 * exactly the broker-provided agent and its working/typing phase. Partial
 * assistant text and truncation stay INSIDE the state machine (protocol
 * state) and are never rendered by the Workbench.
 */
export interface ConversationCompactActivityRun {
  runId: string;
  agent: string;
  phase: "working" | "typing";
}

/** Project the full transient state down to its compact dock representation. */
export function compactActivityRuns(state: ConversationActivityState): ConversationCompactActivityRun[] {
  return state.runs.map((run) => ({ runId: run.runId, agent: run.agent, phase: run.phase }));
}

/** R2 — truthful compact state label for one live run (agent is shown separately). */
export function conversationActivityRunStateLabel(phase: "working" | "typing"): string {
  return phase === "working" ? "is working…" : "is typing…";
}

/** U1 — the normally focusable, labelled scoped abort action for one exact agent run. */
export function conversationActivityRunAbortLabel(agent: string): string {
  return `Abort ${agent}'s current work`;
}

/**
 * U1 — compute at most ONE polite live announcement for a card-set change.
 * Reports each appearance and working→typing transition as a truthful
 * `<agent> is working…` / `<agent> is typing…` line, and each removal as a
 * neutral `<agent> is no longer working` line (never a completion/failure
 * claim). Returns null when the compact card set is byte-identical, so the
 * announcement never fires per token/tick. The compact projection carries no
 * partial text, so no delta content can ever enter an announcement.
 */
export function conversationActivityLiveAnnouncement(
  previous: readonly ConversationCompactActivityRun[],
  next: readonly ConversationCompactActivityRun[],
): string | null {
  const prevByRun = new Map(previous.map((item) => [item.runId, item]));
  const nextByRun = new Map(next.map((item) => [item.runId, item]));
  const parts: string[] = [];
  for (const item of next) {
    const prior = prevByRun.get(item.runId);
    if (prior === undefined || prior.phase !== item.phase) {
      parts.push(`${item.agent} ${conversationActivityRunStateLabel(item.phase)}`);
    }
  }
  for (const item of previous) {
    if (!nextByRun.has(item.runId)) {
      parts.push(`${item.agent} is no longer working`);
    }
  }
  return parts.length === 0 ? null : parts.join(". ");
}

/** Fail-closed: remove every transient run while retaining the settled tombstones. */
export function clearConversationActivity(state: ConversationActivityState): ConversationActivityState {
  return { runs: [], settled: state.settled };
}

/**
 * Apply one validated activity frame to the transient per-run state. A
 * `working` frame sets a working run (partial cleared); each real `text_delta`
 * flips it to typing and accumulates the EXACT deltas up to the bounded cap
 * (a truthful truncation marker is set, never fabricated text); `settled`
 * clears exactly that run. A delta without a preceding working frame still
 * shows truthful typing (the browser tolerates reordered/lost frames).
 */
export function applyConversationActivityFrame(state: ConversationActivityState, frame: ConversationActivityFrame): ConversationActivityState {
  // A known runId (still active) receiving a structurally valid frame with a
  // DIFFERENT agent is contradictory evidence: fail closed by clearing the
  // transient activity rather than applying/mutating it.
  const known = state.runs.find((run) => run.runId === frame.runId);
  if (known !== undefined && known.agent !== frame.agent) {
    return clearConversationActivity(state);
  }
  // A delayed frame for a settled run is stale: it must never recreate a
  // typing/working run (tombstones are in-memory and bounded).
  if (state.settled.includes(frame.runId)) {
    return state;
  }
  if (frame.kind === "settled") {
    const runs = state.runs.filter((run) => run.runId !== frame.runId);
    const settled = [...state.settled, frame.runId];
    if (settled.length > CONVERSATION_ACTIVITY_SETTLED_TOMBSTONES_MAX) {
      settled.shift();
    }
    return { runs, settled };
  }
  if (frame.kind === "working") {
    const others = state.runs.filter((run) => run.runId !== frame.runId);
    return { runs: [...others, { runId: frame.runId, agent: frame.agent, phase: "working", partial: "", truncated: false, tools: [] }], settled: state.settled };
  }
  if (frame.kind === "tool") {
    const line: ConversationToolLine = { name: frame.toolName ?? "", status: frame.status ?? "started" };
    const existingRun = state.runs.find((run) => run.runId === frame.runId);
    if (existingRun === undefined) {
      // Tolerate lost/reordered frames like text_delta does: truthful active
      // work with the tool line attached.
      return { runs: [...state.runs, { runId: frame.runId, agent: frame.agent, phase: "working", partial: "", truncated: false, tools: [line] }], settled: state.settled };
    }
    // Keep at most WORK_CARD_TOOLS_MAX MOST-RECENT lines.
    const tools = [...existingRun.tools, line].slice(-WORK_CARD_TOOLS_MAX);
    return { runs: state.runs.map((run) => (run.runId === frame.runId ? { ...run, tools } : run)), settled: state.settled };
  }
  const delta = frame.delta ?? "";
  const existing = state.runs.find((run) => run.runId === frame.runId);
  if (existing === undefined) {
    const boundedDelta = delta.length > WORK_CARD_TEXT_RETENTION_MAX ? delta.slice(-WORK_CARD_TEXT_RETENTION_MAX) : delta;
    return {
      runs: [...state.runs, { runId: frame.runId, agent: frame.agent, phase: "typing", partial: boundedDelta, truncated: delta.length > WORK_CARD_TEXT_RETENTION_MAX, tools: [] }],
      settled: state.settled,
    };
  }
  const combined = existing.partial + delta;
  // VR-3 rolling retention: keep the MOST RECENT characters within the cap;
  // excess is dropped from the front and never fabricated or persisted.
  const truncated = existing.truncated || combined.length > WORK_CARD_TEXT_RETENTION_MAX;
  const partial = combined.length > WORK_CARD_TEXT_RETENTION_MAX ? combined.slice(-WORK_CARD_TEXT_RETENTION_MAX) : combined;
  return {
    runs: state.runs.map((run) => (run.runId === frame.runId ? { ...run, phase: "typing", partial, truncated } : run)),
    settled: state.settled,
  };
}

/** Clear every transient run for one agent. */
export function clearConversationActivityForAgent(state: ConversationActivityState, agent: string): ConversationActivityState {
  return { runs: state.runs.filter((run) => run.agent !== agent), settled: state.settled };
}

/**
 * Reconcile transient state with DURABLE evidence (never reconstruct activity
 * from history): a durable `agent_message` by that agent replaces the
 * transient partial (the durable event is the authority); a durable terminal
 * (`run_finished`/`run_cancelled`) carrying `runAgent` clears the remaining
 * activity for that agent. Unrelated events and legacy terminals without
 * `runAgent` leave transient state untouched (the `settled` frame covers the
 * live cleanup path).
 */
export function reconcileConversationActivity(state: ConversationActivityState, event: ConversationEventRecord): ConversationActivityState {
  if (event.kind === "agent_message") {
    return clearConversationActivityForAgent(state, event.author);
  }
  if (event.kind === "run_finished" || event.kind === "run_cancelled") {
    const agent = event.runAgent;
    if (typeof agent === "string" && agent !== "") {
      return clearConversationActivityForAgent(state, agent);
    }
  }
  return state;
}

/**
 * VR-3 — the safe bounded render projection for one transient work card.
 *
 * Everything here is browser-memory-only and derived exclusively from the
 * validated live-frame state above (never from durable history, get_messages,
 * telemetry, storage, or any fetch). The projection carries ONLY:
 *   - exact agent/phase (as today);
 *   - `textTail`: the most recent WORK_CARD_TAIL_RENDER_MAX characters of the
 *     retained streamed assistant text as PLAIN TEXT, prefixed by exactly one
 *     leading ellipsis when retention truncated earlier content; null when no
 *     text exists (never an empty-string fabrication). It is never
 *     Markdown-rendered, linkified, or announced;
 *   - `tools`: at most WORK_CARD_TOOLS_MAX most-recent lines, each ONLY a
 *     sanitized name plus the exact started/completed/failed status. Raw tool
 *     arguments/results/output/environment values can never reach it: the
 *     parser rejects payload-shaped fields fail-closed.
 */
export interface ConversationWorkCard {
  runId: string;
  agent: string;
  phase: "working" | "typing";
  textTail: string | null;
  tools: ConversationToolLine[];
}

export function conversationWorkCards(state: ConversationActivityState): ConversationWorkCard[] {
  return state.runs.map((run) => {
    let textTail: string | null = null;
    if (run.partial.length > 0) {
      textTail =
        run.partial.length > WORK_CARD_TAIL_RENDER_MAX
          ? `…${run.partial.slice(-WORK_CARD_TAIL_RENDER_MAX)}`
          : run.partial;
    }
    return {
      runId: run.runId,
      agent: run.agent,
      phase: run.phase,
      textTail,
      // Defensive re-filter at the render boundary: only well-formed safe
      // lines survive, whatever the state holds.
      tools: run.tools
        .filter((line) => TOOL_NAME_PATTERN.test(line.name) && (TOOL_STATUSES as readonly string[]).includes(line.status))
        .slice(-WORK_CARD_TOOLS_MAX),
    };
  });
}
