/**
 * T1 — Dashboard Assign-task transport core. Pure and browser-independent.
 *
 * The browser supplies exactly `{to, title, body}` to the EXISTING
 * authenticated gateway inbox-create route backed by the existing
 * one-file `createInboxTask` core. The server remains the sole metadata
 * authority: `from: steward`, `type: Task`, normal priority,
 * `status: pending`, `requires_approval: false`, generated id/timestamps,
 * and the vault-relative task path are all server-derived and never sent
 * by the browser. This is a narrow creation affordance, not task
 * management: no list, claim, complete, cancel, priority, or approval
 * control exists here.
 */

export interface AssignTaskBody {
  to: string;
  title: string;
  body: string;
}

/** The exact request body contract: trimmed text, no other fields, ever. */
export function buildAssignTaskBody(to: string, title: string, details: string): AssignTaskBody {
  return { to, title: title.trim(), body: details.trim() };
}

export interface InboxTaskCreated {
  taskId: string;
  path: string;
  from: string;
  to: string;
  status: "pending";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Fail-closed parser for the existing route's bounded success response:
 * exactly the five server-derived fields, with `status` pinned to the only
 * value `createInboxTask` ever reports. Any malformed payload throws — the
 * caller shows a bounded error instead of an invented success.
 */
export function parseInboxTaskCreated(json: unknown): InboxTaskCreated {
  if (typeof json !== "object" || json === null) throw new Error("unexpected inbox-create response");
  const record = json as Record<string, unknown>;
  if (!isNonEmptyString(record.taskId) || !isNonEmptyString(record.path) || !isNonEmptyString(record.from) || !isNonEmptyString(record.to)) {
    throw new Error("unexpected inbox-create response");
  }
  if (record.status !== "pending") throw new Error("unexpected inbox-create response");
  return {
    taskId: record.taskId,
    path: record.path,
    from: record.from,
    to: record.to,
    status: "pending",
  };
}
