import { UnauthorizedError } from "./api.js";

export { UnauthorizedError };

/**
 * ST-4: typed browser clients for the closed Agent Groups Settings routes.
 * A 401 surfaces truthfully via the shared typed UnauthorizedError (never
 * regex-matched text); every other HTTP/read failure stays bounded.
 */

export interface GroupSummaryDto {
  name: string;
  revision: string;
}

export interface GroupRosterEntryDto {
  name: string;
  locallyRunnable: boolean;
}

export interface GroupDetailDto {
  name: string;
  revision: string;
  agents: string[];
  fallbackOrder: Record<string, string[]>;
  findings: Array<{ severity: string; kind: string; detail: string }>;
}

/** SR-1: the route returns the roster as a SIBLING of group, never nested. */
export interface GroupDetailRead {
  group: GroupDetailDto;
  roster: GroupRosterEntryDto[];
}

export interface GroupValidationIssueDto {
  group: string;
  kind: "missing-config" | "dangling-fallback" | "missing-agent-dir" | "duplicate-across-groups";
  severity: "error" | "info";
  message: string;
}

async function authed(token: string): Promise<RequestInit> {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function parseAuthorized<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new UnauthorizedError();
  return res.json() as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DETAIL_REJECTED = "Agent group could not be read.";

function parseGroupDto(value: unknown): GroupDetailDto {
  if (!isRecord(value)) throw new Error(DETAIL_REJECTED);
  if (typeof value.name !== "string" || value.name === "" || typeof value.revision !== "string" || value.revision === "") {
    throw new Error(DETAIL_REJECTED);
  }
  if (!Array.isArray(value.agents) || value.agents.some((entry) => typeof entry !== "string")) {
    throw new Error(DETAIL_REJECTED);
  }
  if (!isRecord(value.fallbackOrder)) throw new Error(DETAIL_REJECTED);
  for (const candidates of Object.values(value.fallbackOrder)) {
    if (!Array.isArray(candidates) || candidates.some((entry) => typeof entry !== "string")) {
      throw new Error(DETAIL_REJECTED);
    }
  }
  if (!Array.isArray(value.findings)) throw new Error(DETAIL_REJECTED);
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      typeof finding.severity !== "string" ||
      typeof finding.kind !== "string" ||
      typeof finding.detail !== "string"
    ) {
      throw new Error(DETAIL_REJECTED);
    }
  }
  return {
    name: value.name,
    revision: value.revision,
    agents: value.agents as string[],
    fallbackOrder: value.fallbackOrder as Record<string, string[]>,
    findings: value.findings as GroupDetailDto["findings"],
  };
}

function parseRoster(value: unknown): GroupRosterEntryDto[] {
  if (!Array.isArray(value)) throw new Error(DETAIL_REJECTED);
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "" || typeof entry.locallyRunnable !== "boolean") {
      throw new Error(DETAIL_REJECTED);
    }
  }
  return value as GroupRosterEntryDto[];
}

/**
 * SR-1: strict typed boundary for GET /api/settings/groups/<group>. The
 * documented response carries `roster` as a SIBLING of `group`; a compliant
 * payload normalizes to {group, roster}, while a malformed/missing `group`
 * or `roster` throws one bounded error (shown as the panel's existing
 * notice) so an undefined roster can never reach render.
 */
export function parseGroupsDetailResponse(
  json: unknown,
): { available: true; group: GroupDetailDto; roster: GroupRosterEntryDto[] } | { available: false; reason: string } {
  if (!isRecord(json) || typeof json.available !== "boolean") throw new Error(DETAIL_REJECTED);
  if (json.available === true) {
    return { available: true, group: parseGroupDto(json.group), roster: parseRoster(json.roster) };
  }
  if (typeof json.reason !== "string" || json.reason === "") throw new Error(DETAIL_REJECTED);
  return { available: false, reason: json.reason };
}

export async function fetchGroupsList(token: string): Promise<{ available: boolean; groups?: GroupSummaryDto[]; reason?: string }> {
  const res = await fetch("/api/settings/groups", await authed(token));
  return parseAuthorized(res);
}

export async function fetchGroupDetail(
  name: string,
  token: string,
): Promise<{ available: true; group: GroupDetailDto; roster: GroupRosterEntryDto[] } | { available: false; reason: string }> {
  const res = await fetch(`/api/settings/groups/${encodeURIComponent(name)}`, await authed(token));
  return parseGroupsDetailResponse(await parseAuthorized<unknown>(res));
}

/** Read-only cross-group validation over the existing CLI/core categories. */
export async function fetchGroupsValidation(token: string): Promise<{ available: boolean; issues?: GroupValidationIssueDto[]; reason?: string }> {
  const res = await fetch("/api/settings/groups/validation", await authed(token));
  return parseAuthorized(res);
}

export interface GroupActionInput {
  action: "create" | "add-agent" | "remove-agent" | "fallback-set";
  group: string;
  expectedRevision: string;
  agent?: string;
  candidates?: string[];
  confirm?: boolean;
}

export async function postGroupAction(input: GroupActionInput, token: string): Promise<void> {
  const init = await authed(token);
  const res = await fetch("/api/settings/groups", {
    ...init,
    method: "POST",
    headers: { ...init.headers, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
