export type StewardAlertSeverity = "low" | "normal" | "high" | "urgent";
export type StewardAlertStatus = "open" | "closed";

export interface StewardAlertSummary {
  path: string;
  id: string;
  severity: StewardAlertSeverity;
  status: StewardAlertStatus;
  title: string;
  created: string;
  closedAt?: string;
  closedVia?: "workbench";
}

export interface StewardAlertDetail extends StewardAlertSummary {
  content: string;
}

export interface StewardAlertsResponse {
  attentionCount: number;
  alerts: StewardAlertSummary[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function parseAlert(value: unknown): StewardAlertSummary {
  if (!record(value)) throw new Error("unexpected steward alert");
  const status = value.status;
  const common = ["path", "id", "severity", "status", "title", "created"];
  if (status === "open") {
    if (!exactKeys(value, common)) throw new Error("unexpected open steward alert");
  } else if (status === "closed") {
    if (!exactKeys(value, [...common, "closed_at", "closed_via"])) throw new Error("unexpected closed steward alert");
  } else {
    throw new Error("unexpected steward alert status");
  }
  if (
    typeof value.path !== "string" ||
    !/^steward-inbox\/alerts\/[^/.][^/]*\.md$/.test(value.path) ||
    typeof value.id !== "string" || value.id === "" ||
    !(["low", "normal", "high", "urgent"] as const).includes(value.severity as StewardAlertSeverity) ||
    typeof value.title !== "string" || value.title === "" ||
    !canonicalIso(value.created)
  ) {
    throw new Error("unexpected steward alert");
  }
  const result: StewardAlertSummary = {
    path: value.path,
    id: value.id,
    severity: value.severity as StewardAlertSeverity,
    status,
    title: value.title,
    created: value.created,
  };
  if (status === "closed") {
    if (!canonicalIso(value.closed_at) || value.closed_via !== "workbench") throw new Error("unexpected closed steward alert");
    result.closedAt = value.closed_at;
    result.closedVia = value.closed_via;
  }
  return result;
}

/** Strict decoder for the bounded gateway-owned alert list projection. */
export function parseStewardAlertsResponse(value: unknown): StewardAlertsResponse {
  if (!record(value) || !exactKeys(value, ["attention_count", "alerts"]) || typeof value.attention_count !== "number" || !Number.isInteger(value.attention_count) || value.attention_count < 0 || !Array.isArray(value.alerts)) {
    throw new Error("unexpected steward alert list response");
  }
  return { attentionCount: value.attention_count, alerts: value.alerts.map(parseAlert) };
}

/** Strict decoder for one exact alert detail response. */
export function parseStewardAlertDetail(value: unknown): StewardAlertDetail {
  if (!record(value) || typeof value.content !== "string") throw new Error("unexpected steward alert detail response");
  const { content, ...summary } = value;
  return { ...parseAlert(summary), content };
}
