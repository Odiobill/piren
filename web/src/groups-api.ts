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
  /** Every vault-defined team/<agent>/ identity with its runnable marker. */
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

export async function fetchGroupsList(token: string): Promise<{ available: boolean; groups?: GroupSummaryDto[]; reason?: string }> {
  const res = await fetch("/api/settings/groups", await authed(token));
  return parseAuthorized(res);
}

export async function fetchGroupDetail(name: string, token: string): Promise<{ available: boolean; group?: GroupDetailDto; reason?: string }> {
  const res = await fetch(`/api/settings/groups/${encodeURIComponent(name)}`, await authed(token));
  return parseAuthorized(res);
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
