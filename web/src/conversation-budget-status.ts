/**
 * B6 — pure browser view model for the per-agent context-card workflow
 * status (accepted contract workbench-handoff-budget-and-agent-status-contract
 * §4.1/§6/§7-B6). No DOM, no fetch, no storage: it maps ONLY
 * gateway-provided facts — the exact-pair `workflow-status` snapshot — plus
 * the existing validated scoped live activity runs into a compact labelled
 * indicator `{state, shortText, accessibleText}`.
 *
 * Fixed precedence (§6): red > yellow > busy > none within an associated
 * workflow; busy alone when only `run_active` holds; none otherwise.
 * Red/yellow require an associated workflow and never exist without one.
 * Color and motion are never the sole carrier: every non-none state carries
 * a non-empty static short text, and the busy spin has a CSS
 * reduced-motion static equivalent.
 */

export type WorkflowBudgetStatusState = "red" | "yellow" | "busy" | "none";

export interface WorkflowStatusIndicator {
  state: WorkflowBudgetStatusState;
  /** Static card-visible label (e.g. "running", "budget low"). Empty for none. */
  shortText: string;
  /** Exact accessible phrase (e.g. "dipu is currently running"). Empty for none. */
  accessibleText: string;
}

/** The strictly parsed exact-pair status snapshot facts the view model consumes. */
export interface WorkflowStatusSnapshotView {
  runActive: boolean;
  workflow: {
    effectiveEdges: number;
    consumedEdges: number;
    low: boolean;
    exhausted: boolean;
  } | null;
}

/** Compact live activity run shape (subset of ConversationCompactActivityRun). */
export interface WorkflowStatusActivityRun {
  runId?: string;
  agent: string;
  phase: "working" | "typing";
}

/**
 * W5a — project a complete, already strictly validated B4 status snapshot
 * into the small status-only shape used by the card indicator. The complete
 * snapshot remains available to the associated-workflow budget model.
 */
export function workflowStatusViewFromSnapshot(snapshot: {
  runActive: boolean;
  workflow: {
    effective: { edges: number };
    consumed: { edges: number };
    low: boolean;
    exhausted: boolean;
  } | null;
}): WorkflowStatusSnapshotView {
  return {
    runActive: snapshot.runActive,
    workflow:
      snapshot.workflow === null
        ? null
        : {
            effectiveEdges: snapshot.workflow.effective.edges,
            consumedEdges: snapshot.workflow.consumed.edges,
            low: snapshot.workflow.low,
            exhausted: snapshot.workflow.exhausted,
          },
  };
}

function busyIndicator(agent: string): WorkflowStatusIndicator {
  return { state: "busy", shortText: "running", accessibleText: `${agent} is currently running` };
}

const NONE_INDICATOR: WorkflowStatusIndicator = { state: "none", shortText: "", accessibleText: "" };

/**
 * Trusted-adapter boundary guard (B6 correction): validates that a runtime
 * value really is a parsed snapshot view before the view model reads it.
 * Unexpected values are treated as a non-401 failed read by the consumer —
 * no indicator, no crash, no fabricated fact, no retry.
 */
export function isWorkflowStatusSnapshotView(value: unknown): value is WorkflowStatusSnapshotView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.runActive !== "boolean") return false;
  if (record.workflow === null) return true;
  if (typeof record.workflow !== "object") return false;
  const workflow = record.workflow as Record<string, unknown>;
  return (
    typeof workflow.effectiveEdges === "number" &&
    typeof workflow.consumedEdges === "number" &&
    typeof workflow.low === "boolean" &&
    typeof workflow.exhausted === "boolean"
  );
}

/**
 * Map one exact `conversation × agent` snapshot (plus the agent's validated
 * scoped live activity fact) into the truthful indicator. Never infers from
 * typing indicators, presence, unread, transcript, telemetry, or an agent
 * name: only the snapshot booleans and the validated activity run are read.
 */
export function workflowStatusIndicator(
  agent: string,
  snapshot: WorkflowStatusSnapshotView,
  liveActivityActive: boolean,
): WorkflowStatusIndicator {
  const workflow = snapshot.workflow;
  if (workflow !== null && workflow.exhausted) {
    return {
      state: "red",
      shortText: "budget exhausted",
      accessibleText: `Workflow budget exhausted for ${agent}'s associated workflow; open Context telemetry to extend`,
    };
  }
  if (workflow !== null && workflow.low) {
    const remaining = workflow.effectiveEdges - workflow.consumedEdges;
    return {
      state: "yellow",
      shortText: "budget low",
      accessibleText: `Workflow budget low: ${remaining} of ${workflow.effectiveEdges} handoff edges remaining`,
    };
  }
  if (snapshot.runActive || liveActivityActive) return busyIndicator(agent);
  return NONE_INDICATOR;
}

/**
 * Transition helpers between explicit reads: the existing validated scoped
 * live activity runs may ONLY move the busy dimension — they never make or
 * change workflow association/budget states. A run leaving the dock
 * (settled) clears busy; red/yellow survive both directions untouched.
 */
export function applyWorkflowStatusActivity(
  previous: ReadonlyMap<string, WorkflowStatusIndicator>,
  runs: readonly WorkflowStatusActivityRun[],
): ReadonlyMap<string, WorkflowStatusIndicator> {
  const activeAgents = new Set(runs.map((run) => run.agent));
  const next = new Map<string, WorkflowStatusIndicator>();
  for (const [agent, indicator] of previous) {
    if (indicator.state === "red" || indicator.state === "yellow") {
      next.set(agent, indicator);
      continue;
    }
    if (activeAgents.has(agent)) {
      next.set(agent, busyIndicator(agent));
    }
    // A busy/none indicator whose run left the dock clears to none (absent).
  }
  for (const run of runs) {
    if (!next.has(run.agent)) next.set(run.agent, busyIndicator(run.agent));
  }
  return next;
}

/**
 * Compose the card button's accessible name: the truthful status phrase is
 * inserted before the card hint suffix ("activate for details"); with no
 * indicator (or a none indicator) the base name is returned unchanged.
 */
export function workflowStatusAccessibleName(baseName: string, indicator: WorkflowStatusIndicator | undefined): string {
  if (indicator === undefined || indicator.state === "none") return baseName;
  const suffix = "; activate for details";
  if (baseName.endsWith(suffix)) {
    return `${baseName.slice(0, baseName.length - suffix.length)}; ${indicator.accessibleText}${suffix}`;
  }
  return `${baseName}; ${indicator.accessibleText}`;
}
