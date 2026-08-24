/** ST-4: typed browser clients for the closed Agent Groups Settings routes. */
export interface GroupSummaryDto { name: string; revision: string }
export interface GroupDetailDto {
  name: string; revision: string; agents: string[];
  fallbackOrder: Record<string, string[]>;
  findings: Array<{ severity: string; kind: string; detail: string }>;
}

async function authed(token: string): Promise<RequestInit> {
  return { headers: { authorization: `Bearer ${token}` } };
}

export async function fetchGroupsList(token: string): Promise<{ available: boolean; groups?: GroupSummaryDto[]; reason?: string }> {
  const res = await fetch("/api/settings/groups", await authed(token));
  return res.json();
}

export async function fetchGroupDetail(name: string, token: string): Promise<{ available: boolean; group?: GroupDetailDto; reason?: string }> {
  const res = await fetch(`/api/settings/groups/${encodeURIComponent(name)}`, await authed(token));
  return res.json();
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
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
