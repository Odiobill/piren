/**
 * D2.3 — typed browser model and fail-closed parser for the read-only
 * managed service observation served by GET /api/services/status (accepted
 * contract: Projects/Piren/workbench-dashboard-service-observability-contract.md).
 *
 * Gateway JSON is untrusted: the parser accepts ONLY the exact bounded
 * snapshot — server-generated canonical ISO `observedAt`, the manager enum,
 * and the three fixed targets telegram/discord/scheduler in contract order
 * with the five-state vocabulary. Malformed, extra-field, invalid
 * enum/order, non-canonical-timestamp, or gateway-target payloads are
 * rejected so the Dashboard never displays an invented state. The browser
 * never probes the host itself; this module is pure presentation support.
 */

export type ServiceManagerKind = "systemd-user" | "tmux-cron" | "unavailable";
export type ServiceObservedState = "active" | "inactive" | "not-installed" | "unavailable" | "unknown";
export type ServiceObservationTarget = "telegram" | "discord" | "scheduler";

export interface ServiceTargetObservation {
  target: ServiceObservationTarget;
  state: ServiceObservedState;
}

export interface ServiceStatusSnapshot {
  observedAt: string;
  manager: ServiceManagerKind;
  /** Fixed contract order: telegram, discord, scheduler. */
  targets: ServiceTargetObservation[];
}

const MANAGER_KINDS: ReadonlySet<string> = new Set(["systemd-user", "tmux-cron", "unavailable"]);
const OBSERVED_STATES: ReadonlySet<string> = new Set(["active", "inactive", "not-installed", "unavailable", "unknown"]);
/** Fixed compile-time target order; the gateway target is deliberately absent. */
const EXPECTED_TARGETS: readonly string[] = ["telegram", "discord", "scheduler"];

const PARSE_ERROR = "unexpected /api/services/status response";

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Fail-closed validation of the bounded GET /api/services/status snapshot. */
export function parseServiceStatusSnapshot(json: unknown): ServiceStatusSnapshot {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(PARSE_ERROR);
  }
  const record = json as Record<string, unknown>;
  if (!hasExactKeys(record, ["observedAt", "manager", "targets"])) {
    throw new Error(PARSE_ERROR);
  }
  const { observedAt, manager, targets } = record;
  if (typeof observedAt !== "string") {
    throw new Error(PARSE_ERROR);
  }
  const time = new Date(observedAt);
  if (Number.isNaN(time.getTime()) || time.toISOString() !== observedAt) {
    throw new Error(PARSE_ERROR);
  }
  if (typeof manager !== "string" || !MANAGER_KINDS.has(manager)) {
    throw new Error(PARSE_ERROR);
  }
  if (!Array.isArray(targets) || targets.length !== EXPECTED_TARGETS.length) {
    throw new Error(PARSE_ERROR);
  }
  const parsed: ServiceTargetObservation[] = targets.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(PARSE_ERROR);
    }
    const targetRecord = entry as Record<string, unknown>;
    if (!hasExactKeys(targetRecord, ["target", "state"])) {
      throw new Error(PARSE_ERROR);
    }
    if (targetRecord.target !== EXPECTED_TARGETS[index]) {
      throw new Error(PARSE_ERROR);
    }
    if (typeof targetRecord.state !== "string" || !OBSERVED_STATES.has(targetRecord.state)) {
      throw new Error(PARSE_ERROR);
    }
    return { target: targetRecord.target, state: targetRecord.state } as ServiceTargetObservation;
  });
  return { observedAt, manager: manager as ServiceManagerKind, targets: parsed };
}

/** Display names for the fixed targets (contract vocabulary). */
export const SERVICE_TARGET_LABELS: Record<ServiceObservationTarget, string> = {
  telegram: "Telegram",
  discord: "Discord",
  scheduler: "Scheduler",
};

/**
 * Truthful state labels. `unknown` and `unavailable` are caution states,
 * never success vocabulary: no Healthy/online/running substitution.
 */
export const SERVICE_STATE_LABELS: Record<ServiceObservedState, string> = {
  active: "Active",
  inactive: "Inactive",
  "not-installed": "Not installed",
  unavailable: "Manager unavailable",
  unknown: "Unknown",
};

/** Names the observation source (the manager the gateway sampled through). */
export const SERVICE_MANAGER_LABELS: Record<ServiceManagerKind, string> = {
  "systemd-user": "systemd (user)",
  "tmux-cron": "tmux + cron",
  unavailable: "no supported service manager",
};

/**
 * Status chip class per state: only a directly reported active state is
 * success-styled; unknown/unavailable are visible caution states.
 */
export function serviceStateStatusClass(state: ServiceObservedState): string {
  switch (state) {
    case "active":
      return "status-ok";
    case "inactive":
    case "not-installed":
      return "status-muted";
    case "unavailable":
    case "unknown":
      return "status-warn";
  }
}
