/**
 * B5 — pure browser view model for the W2 Conversation "Workflow budget"
 * section (accepted contract §5). No DOM, no fetch, no storage: strict
 * parsing of the bounded B4 server view and deterministic Save gating /
 * request building. The browser renders gateway facts and sends one typed
 * authenticated request; it never derives or selects a root, never implies
 * a per-agent budget, and never treats the display caps as authority (the
 * gateway decides validity).
 */

/** The bounded B4 budgets view, strictly parsed from the server payload. */
export interface WorkflowBudgetDimensionView {
  edges: number;
  reworkRounds: number;
}

export interface WorkflowBudgetRootView {
  root_event_id: string;
  sequence: number;
  base: WorkflowBudgetDimensionView;
  effective: WorkflowBudgetDimensionView;
  consumed: { edges: number };
  worstPairOccurrences: number;
  low: boolean;
  exhausted: boolean;
  warnings: string[];
  omittedWarnings: number;
}

export interface ConversationWorkflowBudgetsView {
  roots: WorkflowBudgetRootView[];
  total: number;
  omitted: number;
  association: Record<string, { root_event_id: string; association: "active-run" | "latest-run" } | null>;
}

/**
 * Display GUIDANCE mirroring the B1 fixed caps (rendered as field help).
 * They are NOT submission bounds: a changed positive integer target —
 * including out-of-cap — is submitted UNCHANGED so the B4 gateway remains
 * the sole validation authority and its bounded 400 is the truthful
 * outcome (never a local clamp, never a disabled out-of-cap save).
 */
export const WORKFLOW_BUDGET_MAX_EDGES_INPUT = 24;
export const WORKFLOW_BUDGET_MAX_REWORK_ROUNDS_INPUT = 6;

/** The fixed C5 chain-depth limit, displayed as non-editable context only. */
export const WORKFLOW_BUDGET_FIXED_DEPTH = 3;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteInteger(value) && (value as number) >= 0;
}

function parseDimensionView(value: unknown): WorkflowBudgetDimensionView {
  if (typeof value !== "object" || value === null) {
    throw new Error("unexpected workflow budget dimension payload");
  }
  const record = value as Record<string, unknown>;
  if (!isNonNegativeInteger(record.edges) || !isNonNegativeInteger(record.reworkRounds)) {
    throw new Error("unexpected workflow budget dimension payload");
  }
  return { edges: record.edges as number, reworkRounds: record.reworkRounds as number };
}

function parseRootView(value: unknown): WorkflowBudgetRootView {
  if (typeof value !== "object" || value === null) {
    throw new Error("unexpected workflow budget root payload");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.root_event_id !== "string" || record.root_event_id === "") {
    throw new Error("unexpected workflow budget root payload");
  }
  if (!isNonNegativeInteger(record.sequence)) {
    throw new Error("unexpected workflow budget root payload");
  }
  if (
    typeof record.low !== "boolean" ||
    typeof record.exhausted !== "boolean" ||
    !isNonNegativeInteger(record.worstPairOccurrences) ||
    !isNonNegativeInteger(record.omittedWarnings) ||
    !Array.isArray(record.warnings) ||
    record.warnings.some((warning) => typeof warning !== "string")
  ) {
    throw new Error("unexpected workflow budget root payload");
  }
  if (typeof record.consumed !== "object" || record.consumed === null) {
    throw new Error("unexpected workflow budget root payload");
  }
  const consumed = (record.consumed as Record<string, unknown>).edges;
  if (!isNonNegativeInteger(consumed)) {
    throw new Error("unexpected workflow budget root payload");
  }
  return {
    root_event_id: record.root_event_id,
    sequence: record.sequence as number,
    base: parseDimensionView(record.base),
    effective: parseDimensionView(record.effective),
    consumed: { edges: consumed as number },
    worstPairOccurrences: record.worstPairOccurrences as number,
    low: record.low as boolean,
    exhausted: record.exhausted as boolean,
    warnings: record.warnings as string[],
    omittedWarnings: record.omittedWarnings as number,
  };
}

/**
 * Strict allowlist parser for the bounded B4 budgets view. Any malformed
 * payload throws — the browser never renders or sends a fabricated budget
 * fact.
 */
export function parseConversationWorkflowBudgetsView(payload: unknown): ConversationWorkflowBudgetsView {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("unexpected workflow budgets payload");
  }
  const record = payload as Record<string, unknown>;
  if (
    !isNonNegativeInteger(record.total) ||
    !isNonNegativeInteger(record.omitted) ||
    !Array.isArray(record.roots) ||
    typeof record.association !== "object" ||
    record.association === null
  ) {
    throw new Error("unexpected workflow budgets payload");
  }
  const association: ConversationWorkflowBudgetsView["association"] = {};
  for (const [agent, value] of Object.entries(record.association as Record<string, unknown>)) {
    if (value === null) {
      association[agent] = null;
      continue;
    }
    if (typeof value !== "object") throw new Error("unexpected workflow budgets payload");
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.root_event_id !== "string" ||
      entry.root_event_id === "" ||
      (entry.association !== "active-run" && entry.association !== "latest-run")
    ) {
      throw new Error("unexpected workflow budgets payload");
    }
    association[agent] = { root_event_id: entry.root_event_id, association: entry.association };
  }
  return {
    roots: (record.roots as unknown[]).map(parseRootView),
    total: record.total as number,
    omitted: record.omitted as number,
    association,
  };
}

/** Remaining edges for a root (cannot go negative in truthful views). */
export function remainingEdges(root: WorkflowBudgetRootView): number {
  return Math.max(0, root.effective.edges - root.consumed.edges);
}

/** Remaining rework rounds for the worst pair of a root. */
export function remainingReworkRounds(root: WorkflowBudgetRootView): number {
  return Math.max(0, 1 + root.effective.reworkRounds - root.worstPairOccurrences);
}

/** B5 per-root draft state (raw input strings; parsing is deliberate). */
export interface WorkflowBudgetDraft {
  edges: string;
  reworkRounds: string;
}

/**
 * B5 correction: a usable numeric target is ANY positive integer — including
 * out-of-cap — so the gateway's bounded 400 stays reachable and the value is
 * never locally clamped or disabled into a fake success. Non-numeric/empty
 * remains unusable (Save disabled).
 */
function parseDraftTarget(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Save gating (contract §5): at least one target CHANGED from the root's
 * effective value, every provided value is a usable numeric target, and no
 * request is in flight. Non-raising or out-of-cap-but-in-display values
 * stay submittable — the gateway's bounded 400 is the truthful outcome;
 * the browser never clamps.
 */
export function isWorkflowBudgetSaveEnabled(input: {
  draft: WorkflowBudgetDraft;
  effective: WorkflowBudgetDimensionView;
  busy: boolean;
}): boolean {
  if (input.busy) return false;
  const edges = parseDraftTarget(input.draft.edges);
  const reworkRounds = parseDraftTarget(input.draft.reworkRounds);
  // A provided value that fails to parse makes the whole draft unusable.
  if (input.draft.edges.trim() !== "" && edges === null) return false;
  if (input.draft.reworkRounds.trim() !== "" && reworkRounds === null) return false;
  const edgesChanged = edges !== null && edges !== input.effective.edges;
  const reworkChanged = reworkRounds !== null && reworkRounds !== input.effective.reworkRounds;
  return edgesChanged || reworkChanged;
}

/** The closed B4 request body for one explicitly rendered server root. */
export interface WorkflowBudgetUpdateRequest {
  root_event_id: string;
  edges?: number;
  rework_rounds?: number;
  expected_effective: WorkflowBudgetDimensionView;
}

/**
 * Build the exact closed B4 request body from the draft and the LAST
 * fetched effective values (the CAS guard). Returns null when Save is
 * disabled. Only changed dimensions are included; provided-but-unchanged
 * dimensions are omitted.
 */
export function buildWorkflowBudgetUpdateRequest(input: {
  rootEventId: string;
  draft: WorkflowBudgetDraft;
  effective: WorkflowBudgetDimensionView;
  busy: boolean;
}): WorkflowBudgetUpdateRequest | null {
  if (!isWorkflowBudgetSaveEnabled(input)) return null;
  const edges = parseDraftTarget(input.draft.edges);
  const reworkRounds = parseDraftTarget(input.draft.reworkRounds);
  const request: WorkflowBudgetUpdateRequest = {
    root_event_id: input.rootEventId,
    expected_effective: { ...input.effective },
  };
  if (edges !== null && edges !== input.effective.edges) request.edges = edges;
  if (reworkRounds !== null && reworkRounds !== input.effective.reworkRounds) request.rework_rounds = reworkRounds;
  return request;
}
