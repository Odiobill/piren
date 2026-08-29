import { parseAuthInfo, buildAuthHeaders, type AuthInfoResponse } from "./auth";
import {
  parseConversationWorkflowBudgetsView,
  type ConversationWorkflowBudgetsView,
  type WorkflowBudgetDimensionView,
  type WorkflowBudgetUpdateRequest,
} from "./conversation-workflow-budget.js";
import {
  parseConversationAgents,
  type ConversationAgentsResponse,
} from "./conversation-agents";
import { createSseParser, type SseFrame } from "./timeline";
import {
  parseConversationMessageResponse,
  type ConversationMessageResponse,
} from "./conversation-composer";
import {
  parseConversationStartResponse,
  parsePeerStartResponse,
  toConversationStartRequest,
  toPeerStartRequest,
  type ConversationStartResponse,
  type PeerStartResponse,
} from "./conversation-start";
import {
  parseConversationEnvelope,
  parseConversationEvents,
  parseConversationList,
  type ConversationEventRecord,
  type ConversationListResponse,
  type ConversationRecord,
} from "./conversations";
import { parseAttachResponse, type AttachResponse } from "./attach";
import { parseServiceStatusSnapshot, type ServiceStatusSnapshot } from "./service-observation";
import {
  parseLifecycleActionResponse,
  parseLifecycleHttpError,
  type ConversationLifecycleAction,
  type LifecycleActionResponse,
} from "./conversation-lifecycle";
import {
  parseRenameHttpError,
  parseRenameResponse,
  type RenameResponse,
} from "./conversation-details";
import {
  buildConversationApproveBody,
  parseConversationAbortOutcome,
  parseConversationControlHttpError,
  type ApprovalResponse,
  type ConversationAbortOutcome,
} from "./conversation-controls";
import { parseConversationTelemetryReadResponse, type ConversationTelemetryReadResult } from "./conversation-telemetry";
import { parseVaultListResponse, parseVaultReadResponse, type VaultListResponse, type VaultOrdering, type VaultReadResponse } from "./vault-explorer";
import { buildAssignTaskBody, parseInboxTaskCreated, type InboxTaskCreated } from "./dashboard-task";
import {
  buildAgentContextInjectionEnvelope,
  buildAgentModelEnvelope,
  buildAgentModelFallbackEnvelope,
  buildAgentSelfImprovementEnvelope,
  buildDiscordSettingsEnvelope,
  buildSchedulerSettingsEnvelope,
  buildTelegramSettingsEnvelope,
  parseAgentPreferencesRead,
  parseDiscordSettingsRead,
  parseSchedulerSettingsRead,
  parseSettingsWriteResponse,
  parseTelegramSettingsRead,
  type AgentModelFallbackPatchInput,
  type AgentModelPatchInput,
  type AgentPreferencesProjection,
  type AgentSelfImprovementPatchInput,
  type DiscordSettingsPatchInput,
  type DiscordSettingsProjection,
  type SchedulerSettingsPatchInput,
  type SchedulerSettingsProjection,
  type SettingsReadResult,
  type TelegramSettingsPatchInput,
  type TelegramSettingsProjection,
} from "./settings-transport";

/** Typed bounded lifecycle action error (L2 404/409/500 / network). */
export class LifecycleHttpError extends Error {
  readonly kind: "not-found" | "conflict" | "server" | "network";

  constructor(kind: "not-found" | "conflict" | "server" | "network", message: string) {
    super(message);
    this.name = "LifecycleHttpError";
    this.kind = kind;
  }
}

/**
 * Typed fetch client for the existing gateway /api/* surface. The workbench
 * shell consumes the public auth-info probe plus the authenticated
 * conversation-agents roster (decommission rename, ADR-0043); the C3-A
 * Conversation surface uses the accepted conversation API family. Every
 * protected call carries the in-memory Bearer token and surfaces 401
 * truthfully via UnauthorizedError (never silently retried).
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("the gateway rejected the bearer token");
    this.name = "UnauthorizedError";
  }
}

export async function fetchAuthInfo(signal?: AbortSignal): Promise<AuthInfoResponse> {
  // exactOptionalPropertyTypes: never pass { signal: undefined } as init.
  const init = signal === undefined ? undefined : { signal };
  const res = await fetch("/api/auth/info", init);
  if (!res.ok) throw new Error(`auth info HTTP ${res.status}`);
  return parseAuthInfo(await res.json());
}

async function authedFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...buildAuthHeaders(token),
    ...((init?.headers ?? {}) as Record<string, string>),
  };
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

/** GET /api/conversation-agents — local-policy roster (online = locally runnable). */
export async function fetchConversationAgents(token: string, signal?: AbortSignal): Promise<ConversationAgentsResponse> {
  const res = await authedFetch("/api/conversation-agents", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversation agents HTTP ${res.status}`);
  return parseConversationAgents(await res.json());
}

/**
 * GET /api/services/status — one fresh, read-only managed service
 * observation sampled by the gateway at request time. A 401 surfaces through
 * UnauthorizedError; any other non-200 (including the bounded 503) or a
 * payload failing the strict snapshot parser is a failure — never an
 * invented state.
 */
export async function fetchServiceStatus(token: string, signal?: AbortSignal): Promise<ServiceStatusSnapshot> {
  const res = await authedFetch("/api/services/status", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`service status HTTP ${res.status}`);
  return parseServiceStatusSnapshot(await res.json());
}

// ---------------------------------------------------------------------------
// C3-A — Conversation surface transport over the accepted C2 API family
// ---------------------------------------------------------------------------

/** GET /api/conversations — durable conversation list, newest-first. */
export async function fetchConversations(token: string, signal?: AbortSignal): Promise<ConversationListResponse> {
  const res = await authedFetch("/api/conversations", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversations HTTP ${res.status}`);
  return parseConversationList(await res.json());
}

/** GET /api/conversations/<id> — read one conversation manifest. */
export async function fetchConversation(id: string, token: string, signal?: AbortSignal): Promise<ConversationRecord> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversation ${id} HTTP ${res.status}`);
  return parseConversationEnvelope(await res.json());
}

/**
 * ADR-0044 — POST /api/conversations/start with exactly `{agent}`: the
 * explicit steward-selected runnable agent and nothing else. The browser
 * never derives a recipient, synthesizes text, or passes any other field.
 */
export async function startConversation(token: string, agent: string): Promise<ConversationStartResponse> {
  const res = await authedFetch("/api/conversations/start", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toConversationStartRequest(agent)),
  });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") reason = body.error;
    } catch {
      // keep the HTTP status reason
    }
    throw new Error(reason);
  }
  return parseConversationStartResponse(await res.json());
}

/**
 * P3.3 — a network-level peer start failure is AMBIGUOUS: the request may
 * have landed. The Dashboard offers only an explicit durable-list refresh
 * through its narrow shell callback; there is no automatic retry and no
 * success claim.
 */
export class PeerStartAmbiguousError extends Error {
  constructor() {
    super("the peer conversation may or may not have been created");
    this.name = "PeerStartAmbiguousError";
  }
}

/**
 * P3.3 — POST /api/conversations/start-peer (P2 accepted route): exactly the
 * `{peers}` body; 201 safe `{conversation, event}` parsing with dispatch
 * absence pinned by the fail-closed parser. A 401 surfaces through
 * UnauthorizedError; a definitive non-201 response carries the server's
 * bounded reason; a network-level failure is PeerStartAmbiguousError.
 */
export async function startPeerConversation(peers: readonly string[], token: string): Promise<PeerStartResponse> {
  let res: Response;
  try {
    res = await authedFetch("/api/conversations/start-peer", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toPeerStartRequest(peers)),
    });
  } catch (cause) {
    if (cause instanceof UnauthorizedError) throw cause;
    throw new PeerStartAmbiguousError();
  }
  // Result classification: exactly 201 is success. Definitive authenticated
  // 4xx (401 already surfaced) keeps the bounded server reason and permits an
  // explicit fresh retry. EVERY other status — non-201 2xx/3xx and 5xx — is
  // ambiguous: the POST may have landed, so it must never enable a fresh
  // retry that could duplicate durable evidence.
  if (res.status !== 201) {
    if (res.status >= 400 && res.status <= 499) {
      let reason = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error !== "") reason = body.error;
      } catch {
        // keep the HTTP status reason
      }
      throw new Error(reason);
    }
    throw new PeerStartAmbiguousError();
  }
  try {
    // A 201 whose body cannot be read or fails the safe parser is an
    // AMBIGUOUS result: creation may have landed. Never a definitive error.
    return parsePeerStartResponse(await res.json());
  } catch {
    throw new PeerStartAmbiguousError();
  }
}

/**
 * POST /api/conversations/<id>/attach — the C1/runnable-roster-gated attach.
 * The gateway applies `checkActiveGate` against the local runnable set; the
 * response decides the presentation (active vs read-only inspection). This
 * route is stateless server-side.
 */
export async function attachConversation(id: string, token: string): Promise<AttachResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/attach`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status === 409) return parseAttachResponse(await res.json());
  if (!res.ok) throw new Error(`attach HTTP ${res.status}`);
  return parseAttachResponse(await res.json());
}

/** POST /api/conversations/<id>/messages — raw-text follow-up composer. */
export async function sendConversationMessage(
  id: string,
  text: string,
  token: string,
): Promise<ConversationMessageResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/messages`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") reason = body.error;
    } catch {
      // keep the HTTP status reason
    }
    throw new Error(reason);
  }
  return parseConversationMessageResponse(await res.json());
}

async function postLifecycleAction(
  id: string,
  action: ConversationLifecycleAction,
  token: string,
): Promise<LifecycleActionResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/${action}`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status === 200) return parseLifecycleActionResponse(await res.json());
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseLifecycleHttpError(res.status, json);
  throw new LifecycleHttpError(parsed.kind, parsed.message);
}

/** POST /api/conversations/<id>/archive — L2 lifecycle action (state-only). */
export async function archiveConversation(id: string, token: string): Promise<LifecycleActionResponse> {
  return postLifecycleAction(id, "archive", token);
}

/** POST /api/conversations/<id>/reopen — L2 lifecycle action (state-only). */
export async function reopenConversation(id: string, token: string): Promise<LifecycleActionResponse> {
  return postLifecycleAction(id, "reopen", token);
}

/** Typed bounded error from the U2 rename route (400/404/409/500 / network). */
export class RenameHttpError extends Error {
  readonly kind: "invalid-title" | "not-found" | "conflict" | "server" | "network";

  constructor(kind: "invalid-title" | "not-found" | "conflict" | "server" | "network", message: string) {
    super(message);
    this.name = "RenameHttpError";
    this.kind = kind;
  }
}

/**
 * POST /api/conversations/<id>/rename — bounded steward-facing title change.
 * Sends the raw trimmed title only; the gateway validates and applies it, and
 * the returned conversation/event are used only as the result of this
 * authenticated operation (the navigator then re-reads/re-gates).
 */
export async function renameConversation(id: string, title: string, token: string): Promise<RenameResponse> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/rename`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (res.status === 200) return parseRenameResponse(await res.json());
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseRenameHttpError(res.status, json);
  throw new RenameHttpError(parsed.kind, parsed.message);
}

/** Typed bounded error from the C3-C2 approve/abort routes. */
export class ConversationControlHttpError extends Error {
  readonly kind: "bad-request" | "not-found" | "stale" | "server" | "network";

  constructor(kind: "bad-request" | "not-found" | "stale" | "server" | "network", message: string) {
    super(message);
    this.name = "ConversationControlHttpError";
    this.kind = kind;
  }
}

/**
 * POST /api/conversations/<id>/approve — forward one exactly-one approval
 * response to the exact pending conversation×agent request. Success is
 * delivery acceptance only; the browser never fabricates an agent outcome.
 */
export async function approveConversationApproval(
  id: string,
  agent: string,
  requestId: string,
  response: ApprovalResponse,
  token: string,
): Promise<void> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/approve`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildConversationApproveBody(agent, requestId, response)),
  });
  if (res.status === 200) return;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseConversationControlHttpError(res.status, json);
  throw new ConversationControlHttpError(parsed.kind, parsed.message);
}

/**
 * POST /api/conversations/<id>/abort — abort the active run for exactly one
 * conversation×agent key; returns the bounded cancelled|no-active-run outcome.
 */
export async function abortConversationRun(id: string, agent: string, token: string): Promise<ConversationAbortOutcome> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/abort`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  if (res.status === 200) return parseConversationAbortOutcome(await res.json());
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep the typed fallback
  }
  const parsed = parseConversationControlHttpError(res.status, json);
  throw new ConversationControlHttpError(parsed.kind, parsed.message);
}

/** GET /api/conversations/<id>/events — whole durable history (no replay). */
export async function fetchConversationEvents(id: string, token: string, signal?: AbortSignal): Promise<ConversationEventRecord[]> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/events`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`conversation events HTTP ${res.status}`);
  return parseConversationEvents(await res.json());
}

/**
 * T6 — GET /api/conversations/<id>/agents/<agent>/telemetry: one explicit,
 * authenticated, read-only scoped telemetry read for the exact pair. Called
 * ONLY by the explicit steward refresh control — never on mount, selection,
 * SSE receipt, timer, reconnect, or failure retry. A 401 surfaces through
 * UnauthorizedError; any other non-200 or an invalid/leaking payload throws.
 */
/**
 * B5 — typed failure for the workflow-budget update route: carries the HTTP
 * status and the bounded non-secret server reason so the modal can render
 * the exact bounded 400/404/409/500 outcome with explicit Retry.
 */
export class WorkflowBudgetHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "WorkflowBudgetHttpError";
  }
}

/** B5 — GET /api/conversations/<id>/workflow-budgets (bounded server view). */
export async function fetchConversationWorkflowBudgets(
  id: string,
  token: string,
): Promise<ConversationWorkflowBudgetsView> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/workflow-budgets`, token);
  if (!res.ok) throw new WorkflowBudgetHttpError(res.status, `workflow budgets HTTP ${res.status}`);
  return parseConversationWorkflowBudgetsView(await res.json());
}

/**
 * B5 — POST /api/conversations/<id>/workflow-budget with the exact closed
 * B4 body ({root_event_id, edges?, rework_rounds?, expected_effective}).
 * 200 returns the server-confirmed effective values; every non-200 is a
 * WorkflowBudgetHttpError carrying the bounded server reason.
 */
export async function updateConversationWorkflowBudget(
  id: string,
  request: WorkflowBudgetUpdateRequest,
  token: string,
): Promise<{ status: "updated"; effective: WorkflowBudgetDimensionView }> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/workflow-budget`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (res.status !== 200) {
    let reason = `workflow budget update HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim() !== "") reason = body.error;
    } catch {
      // Bounded fallback reason already set.
    }
    throw new WorkflowBudgetHttpError(res.status, reason);
  }
  const body = (await res.json()) as { status?: unknown; effective?: unknown };
  if (body.status !== "updated") throw new WorkflowBudgetHttpError(res.status, "unexpected workflow budget update response");
  const effective = parseWorkflowBudgetEffective(body.effective);
  return { status: "updated", effective };
}

function parseWorkflowBudgetEffective(value: unknown): WorkflowBudgetDimensionView {
  if (typeof value !== "object" || value === null) {
    throw new WorkflowBudgetHttpError(200, "unexpected workflow budget update response");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isFinite(record.edges) || !Number.isInteger(record.edges) || (record.edges as number) < 0 ||
    !Number.isFinite(record.reworkRounds) || !Number.isInteger(record.reworkRounds) || (record.reworkRounds as number) < 0
  ) {
    throw new WorkflowBudgetHttpError(200, "unexpected workflow budget update response");
  }
  return { edges: record.edges as number, reworkRounds: record.reworkRounds as number };
}

export async function fetchConversationTelemetry(id: string, agent: string, token: string): Promise<ConversationTelemetryReadResult> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}/telemetry`, token);
  if (!res.ok) throw new Error(`conversation telemetry HTTP ${res.status}`);
  return parseConversationTelemetryReadResponse(await res.json());
}

/**
 * W2 — GET /api/vault/list?path=<vault-relative> over the EXISTING bounded
 * read-only route. Vault paths originate from server entries or the bounded
 * root; the query path is encoded. A 401 surfaces through UnauthorizedError;
 * any other non-200 or a payload failing the strict parser is a failure.
 */
export async function fetchVaultList(
  path: string,
  token: string,
  signal?: AbortSignal,
  ordering?: VaultOrdering,
): Promise<VaultListResponse> {
  // WUX-B: additive closed ordering value on the SAME route. "name" is the
  // server default, so it is never sent explicitly.
  const suffix = ordering === "recent" ? "&order=recent" : "";
  const res = await authedFetch(`/api/vault/list?path=${encodeURIComponent(path)}${suffix}`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`vault list HTTP ${res.status}`);
  return parseVaultListResponse(await res.json());
}

/**
 * W2 — GET /api/vault/read?path=<vault-relative> over the EXISTING bounded
 * read-only route. Same fail-closed contract as fetchVaultList.
 */
export async function fetchVaultRead(path: string, token: string, signal?: AbortSignal): Promise<VaultReadResponse> {
  const res = await authedFetch(`/api/vault/read?path=${encodeURIComponent(path)}`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`vault read HTTP ${res.status}`);
  return parseVaultReadResponse(await res.json());
}

/**
 * T1 — POST to the EXISTING authenticated one-file inbox-create
 * route behind the existing `createInboxTask` core. The browser sends exactly
 * `{to, title, body}` (trimmed); the server derives every other field (from:
 * steward, type Task, normal priority, pending, requires_approval,
 * id/timestamps/path). One explicit submit, no automatic retry; a 401
 * surfaces through UnauthorizedError and any other non-200 is a bounded
 * error carrying the server's redacted reason. Creation evidence only —
 * never a claim of contact, notification, wakeup, or execution.
 */
export async function assignInboxTask(to: string, title: string, details: string, token: string): Promise<InboxTaskCreated> {
  const res = await authedFetch("/api/vault/inbox", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildAssignTaskBody(to, title, details)),
  });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") reason = body.error;
    } catch {
      // keep the HTTP status reason
    }
    throw new Error(reason);
  }
  return parseInboxTaskCreated(await res.json());
}

/**
 * W5 — typed transport Settings transport over the EXISTING gateway auth
 * gate. Narrow per-transport read/write routes only (no generic /api/
 * settings reader/patcher); reads are fully redacted; writes carry the
 * closed envelope plus an optional write-only token, and the response never
 * echoes it. A 401 surfaces through UnauthorizedError; non-401 write
 * failures surface as a bounded typed SettingsHttpError.
 */
export type SettingsHttpErrorKind = "invalid" | "conflict" | "server" | "network";

export class SettingsHttpError extends Error {
  readonly kind: SettingsHttpErrorKind;
  constructor(kind: SettingsHttpErrorKind, message: string) {
    super(message);
    this.name = "SettingsHttpError";
    this.kind = kind;
  }
}

/** GET /api/settings/telegram — redacted telegram projection. */
export async function fetchTelegramSettings(token: string, signal?: AbortSignal): Promise<SettingsReadResult<TelegramSettingsProjection>> {
  const res = await authedFetch("/api/settings/telegram", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`telegram settings HTTP ${res.status}`);
  return parseTelegramSettingsRead(await res.json());
}

/** GET /api/settings/discord — redacted discord projection. */
export async function fetchDiscordSettings(token: string, signal?: AbortSignal): Promise<SettingsReadResult<DiscordSettingsProjection>> {
  const res = await authedFetch("/api/settings/discord", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`discord settings HTTP ${res.status}`);
  return parseDiscordSettingsRead(await res.json());
}

async function postSettings(path: string, body: Record<string, unknown>, token: string): Promise<void> {
  let res: Response;
  try {
    res = await authedFetch(path, token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof UnauthorizedError) throw cause;
    throw new SettingsHttpError("network", "The settings save could not reach the gateway.");
  }
  if (res.status === 200) {
    parseSettingsWriteResponse(await res.json());
    return;
  }
  const kind: SettingsHttpErrorKind = res.status === 400 ? "invalid" : res.status === 409 ? "conflict" : "server";
  throw new SettingsHttpError(kind, kind === "conflict" ? "The config changed since it was read; re-read and retry." : "The settings save failed; nothing was changed.");
}

/** POST /api/settings/telegram — closed telegram patch (write-only token). */
export async function saveTelegramSettings(block: TelegramSettingsPatchInput, token: string): Promise<void> {
  await postSettings("/api/settings/telegram", buildTelegramSettingsEnvelope(block), token);
}

/** POST /api/settings/discord — closed discord patch (write-only token). */
export async function saveDiscordSettings(block: DiscordSettingsPatchInput, token: string): Promise<void> {
  await postSettings("/api/settings/discord", buildDiscordSettingsEnvelope(block), token);
}

/**
 * W6 — typed scheduler + vault-owned agent-preference Settings transport.
 * Same existing-auth/redaction/foundation contract as W5. Agent routes are
 * path-contained (`/api/settings/agents/<agent>`); the agent is a locally-
 * runnable name only.
 */
export async function fetchSchedulerSettings(token: string, signal?: AbortSignal): Promise<SettingsReadResult<SchedulerSettingsProjection>> {
  const res = await authedFetch("/api/settings/scheduler", token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`scheduler settings HTTP ${res.status}`);
  return parseSchedulerSettingsRead(await res.json());
}

export async function saveSchedulerSettings(block: SchedulerSettingsPatchInput, token: string): Promise<void> {
  await postSettings("/api/settings/scheduler", buildSchedulerSettingsEnvelope(block), token);
}

export async function fetchAgentPreferences(agent: string, token: string, signal?: AbortSignal): Promise<SettingsReadResult<AgentPreferencesProjection>> {
  const res = await authedFetch(`/api/settings/agents/${encodeURIComponent(agent)}`, token, signal === undefined ? undefined : { signal });
  if (!res.ok) throw new Error(`agent settings HTTP ${res.status}`);
  return parseAgentPreferencesRead(await res.json());
}

export async function saveAgentModel(agent: string, block: AgentModelPatchInput, token: string): Promise<void> {
  await postSettings(`/api/settings/agents/${encodeURIComponent(agent)}`, buildAgentModelEnvelope(agent, block), token);
}

export async function saveAgentModelFallback(
  agent: string,
  block: AgentModelFallbackPatchInput,
  confirmAutoSwitch: boolean,
  token: string,
): Promise<void> {
  await postSettings(`/api/settings/agents/${encodeURIComponent(agent)}`, buildAgentModelFallbackEnvelope(agent, block, confirmAutoSwitch), token);
}

export async function saveAgentContextInjection(agent: string, mode: "per_turn" | "session_start_only", token: string): Promise<void> {
  await postSettings(`/api/settings/agents/${encodeURIComponent(agent)}`, buildAgentContextInjectionEnvelope(agent, mode), token);
}

export async function saveAgentSelfImprovement(agent: string, block: AgentSelfImprovementPatchInput, token: string): Promise<void> {
  await postSettings(`/api/settings/agents/${encodeURIComponent(agent)}`, buildAgentSelfImprovementEnvelope(agent, block), token);
}

export interface ConversationEventStreamHandlers {
  onFrame: (frame: SseFrame) => void;
  onOpen?: () => void;
}

/**
 * GET /api/conversations/<id>/events/stream — scoped live SSE consumed with
 * fetch so the in-memory Bearer header is carried. Resolves when the stream
 * ends; the caller decides the reconnect policy (whole-history reread +
 * re-subscription). Used ONLY after a successful attach.
 */
export async function streamConversationEvents(
  id: string,
  token: string,
  handlers: ConversationEventStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}/events/stream`, token, { signal });
  if (!res.ok) throw new Error(`conversation stream HTTP ${res.status}`);
  handlers.onOpen?.();
  const body = res.body;
  if (body === null) throw new Error("conversation stream has no body");
  const reader = body.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        handlers.onFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
