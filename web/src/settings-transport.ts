/**
 * W5 (0.2.0 scope amendment §5/§5.1; ADR-0046) — pure typed transport
 * Settings cores for the Workbench. Framework-free: fail-closed parsers for
 * the redacted read projections (counts + default-agent + feedback only —
 * never a token, raw id list, fingerprint, or config), structural chat-id/
 * snowflake validators mirroring the accepted CLI transport-configure
 * contracts, closed write intent builders, and the fully-redacted write
 * response parser. No fetch, no storage, no secrets.
 */

// ---------------------------------------------------------------------------
// Redacted read projections (mirror the server-side W4 foundation)
// ---------------------------------------------------------------------------

export interface TelegramSettingsProjection {
  configured: boolean;
  /** Count only — the actual chat IDs are never returned to the browser. */
  allowedChatIds: number;
  defaultAgent: string | null;
  feedbackEnabled: boolean | null;
}

export interface DiscordSettingsProjection {
  configured: boolean;
  allowedGuildIds: number;
  allowedChannelIds: number;
  allowedThreadIds: number | null;
  allowedDmUserIds: number | null;
  defaultAgent: string | null;
  feedbackEnabled: boolean | null;
}

export type SettingsReadResult<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown): boolean | "invalid" {
  return typeof value === "boolean" ? value : "invalid";
}

/** Absent optional booleans are legitimately represented as null in the redacted read projection; any other non-boolean type is invalid. */
function asBooleanOrNull(value: unknown): boolean | null | "invalid" {
  if (value === null) return null;
  return asBoolean(value);
}

function asCount(value: unknown): number | "invalid" {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : "invalid";
}

function asCountOrNull(value: unknown): number | null | "invalid" {
  if (value === null) return null;
  return asCount(value);
}

function asStringOrNull(value: unknown): string | null | "invalid" {
  if (value === null) return null;
  return typeof value === "string" ? value : "invalid";
}

function parseTelegramProjection(value: unknown): TelegramSettingsProjection {
  if (!isRecord(value)) throw new Error("unexpected telegram settings projection");
  if (asBoolean(value.configured) === "invalid") throw new Error("unexpected telegram settings projection");
  if (asCount(value.allowedChatIds) === "invalid") throw new Error("unexpected telegram settings projection");
  if (asStringOrNull(value.defaultAgent) === "invalid") throw new Error("unexpected telegram settings projection");
  const feedback = value.feedbackEnabled === null ? null : asBoolean(value.feedbackEnabled);
  if (feedback === "invalid") throw new Error("unexpected telegram settings projection");
  return {
    configured: value.configured as boolean,
    allowedChatIds: value.allowedChatIds as number,
    defaultAgent: value.defaultAgent as string | null,
    feedbackEnabled: feedback,
  };
}

function parseDiscordProjection(value: unknown): DiscordSettingsProjection {
  if (!isRecord(value)) throw new Error("unexpected discord settings projection");
  if (asBoolean(value.configured) === "invalid") throw new Error("unexpected discord settings projection");
  if (asCount(value.allowedGuildIds) === "invalid") throw new Error("unexpected discord settings projection");
  if (asCount(value.allowedChannelIds) === "invalid") throw new Error("unexpected discord settings projection");
  if (asCountOrNull(value.allowedThreadIds) === "invalid") throw new Error("unexpected discord settings projection");
  if (asCountOrNull(value.allowedDmUserIds) === "invalid") throw new Error("unexpected discord settings projection");
  if (asStringOrNull(value.defaultAgent) === "invalid") throw new Error("unexpected discord settings projection");
  const feedback = value.feedbackEnabled === null ? null : asBoolean(value.feedbackEnabled);
  if (feedback === "invalid") throw new Error("unexpected discord settings projection");
  return {
    configured: value.configured as boolean,
    allowedGuildIds: value.allowedGuildIds as number,
    allowedChannelIds: value.allowedChannelIds as number,
    allowedThreadIds: value.allowedThreadIds as number | null,
    allowedDmUserIds: value.allowedDmUserIds as number | null,
    defaultAgent: value.defaultAgent as string | null,
    feedbackEnabled: feedback,
  };
}

/** Fail-closed parser for GET /api/settings/telegram. */
export function parseTelegramSettingsRead(json: unknown): SettingsReadResult<TelegramSettingsProjection> {
  if (!isRecord(json) || typeof json.available !== "boolean") {
    throw new Error("unexpected telegram settings read");
  }
  if (json.available === true) {
    return { available: true, value: parseTelegramProjection(json.telegram) };
  }
  if (typeof json.reason !== "string" || json.reason === "") {
    throw new Error("unexpected telegram settings read");
  }
  return { available: false, reason: json.reason };
}

/** Fail-closed parser for GET /api/settings/discord. */
export function parseDiscordSettingsRead(json: unknown): SettingsReadResult<DiscordSettingsProjection> {
  if (!isRecord(json) || typeof json.available !== "boolean") {
    throw new Error("unexpected discord settings read");
  }
  if (json.available === true) {
    return { available: true, value: parseDiscordProjection(json.discord) };
  }
  if (typeof json.reason !== "string" || json.reason === "") {
    throw new Error("unexpected discord settings read");
  }
  return { available: false, reason: json.reason };
}

/** Fail-closed parser for the fully-redacted write response ({ wrote: true }). */
export function parseSettingsWriteResponse(json: unknown): void {
  if (!isRecord(json) || json.wrote !== true) {
    throw new Error("unexpected settings write response");
  }
  // Fully redacted: the response must carry nothing else.
  if (Object.keys(json).length !== 1) {
    throw new Error("unexpected settings write response");
  }
}

// ---------------------------------------------------------------------------
// Closed write intent builders
// ---------------------------------------------------------------------------

export interface TelegramSettingsPatchInput {
  botToken?: string;
  allowedChatIds?: number[];
  defaultAgent?: string;
  feedbackEnabled?: boolean;
}

export interface DiscordSettingsPatchInput {
  botToken?: string;
  allowedGuildIds?: string[];
  allowedChannelIds?: string[];
  allowedThreadIds?: string[];
  allowedDmUserIds?: string[];
  defaultAgent?: string;
  feedbackEnabled?: boolean;
}

export function buildTelegramSettingsEnvelope(block: TelegramSettingsPatchInput): Record<string, unknown> {
  return { surface: "local", family: "telegram", block };
}

export function buildDiscordSettingsEnvelope(block: DiscordSettingsPatchInput): Record<string, unknown> {
  return { surface: "local", family: "discord", block };
}

// ---------------------------------------------------------------------------
// Structural input validation (mirrors src/transport-configure.ts contracts)
// ---------------------------------------------------------------------------

export type ChatIdsParseResult = { ok: true; ids: number[] } | { ok: false; error: string };
export type SnowflakesParseResult = { ok: true; ids: string[] } | { ok: false; error: string };

/** Mirror of the accepted CLI telegram chat-id contract. */
export function parseTelegramChatIdsInput(input: string): ChatIdsParseResult {
  const parts = input.split(",").map((part) => part.trim());
  if (parts.length === 1 && parts[0] === "") {
    return { ok: false, error: "At least one chat ID is required." };
  }
  const ids: number[] = [];
  for (const part of parts) {
    if (part === "") {
      return { ok: false, error: "Empty entry in the chat ID list. Separate IDs with commas." };
    }
    if (!/^-?\d+$/.test(part)) {
      return { ok: false, error: "Invalid chat ID: expected an integer (group IDs are negative)." };
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value)) {
      return { ok: false, error: "Invalid chat ID: outside the safe integer range." };
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return { ok: true, ids };
}

/** Mirror of the accepted CLI discord snowflake contract (15-22 digits). */
export function parseDiscordSnowflakesInput(
  input: string,
  field: string,
  noun: string,
  options: { optional?: boolean } = {},
): SnowflakesParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    if (options.optional) return { ok: true, ids: [] };
    return { ok: false, error: `At least one ${noun} ID is required in ${field}.` };
  }
  if (options.optional && trimmed.toLowerCase() === "none") {
    return { ok: true, ids: [] };
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  const ids: string[] = [];
  for (const part of parts) {
    if (part === "") {
      return { ok: false, error: `Empty entry in ${field}. Separate IDs with commas.` };
    }
    if (!/^\d{15,22}$/.test(part)) {
      return { ok: false, error: `Invalid entry in ${field}: expected a Discord ${noun} ID (15-22 digits).` };
    }
    if (!ids.includes(part)) ids.push(part);
  }
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------
// W6 — scheduler + vault-owned agent-preference Settings cores
// ---------------------------------------------------------------------------

export interface SchedulerSettingsProjection {
  present: boolean;
  /** ST-1A: closed retired-master-gate state; never a raw enabled boolean. */
  legacyMasterGate: "absent" | "ignored" | "gated";
  automation: { inboxTasks: boolean; agentCron: boolean; scriptCron: boolean };
  deviceIdConfigured: boolean;
  pollIntervalSeconds: number | null;
  staleAfterSeconds: number | null;
  maxConcurrentAgents: number | null;
  deviceId: string | null;
}

export interface AgentPreferencesProjection {
  model: { id: string | null; thinking: string | null };
  modelFallback: { declared: boolean; autoSwitch: boolean | null; modelCount: number; models: string[] };
  contextInjection: { mode: string | null };
  selfImprovement: {
    autoNudge: boolean | null;
    reviewLoopEnabled: boolean | null;
    reviewLoop: { intervalTurns: number | null; recentMessages: number | null; timeoutMs: number | null };
  };
}

function asOptionalPositiveIntOrNull(value: unknown): number | null | "invalid" {
  if (value === null) return null;
  return asCount(value);
}

function asStringList(value: unknown): string[] | "invalid" {
  if (!Array.isArray(value)) return "invalid";
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") return "invalid";
    out.push(entry);
  }
  return out;
}

function asMode(value: unknown): string | null | "invalid" {
  if (value === null) return null;
  return typeof value === "string" ? value : "invalid";
}

/** Fail-closed parser for the scheduler read projection. */
export function parseSchedulerSettingsRead(json: unknown): SettingsReadResult<SchedulerSettingsProjection> {
  if (!isRecord(json) || typeof json.available !== "boolean") {
    throw new Error("unexpected scheduler settings read");
  }
  if (json.available === true) {
    const s = json.scheduler;
    if (!isRecord(s)) throw new Error("unexpected scheduler settings read");
    if (typeof s.present !== "boolean" || typeof s.deviceIdConfigured !== "boolean") {
      throw new Error("unexpected scheduler settings read");
    }
    if (s.legacyMasterGate !== "absent" && s.legacyMasterGate !== "ignored" && s.legacyMasterGate !== "gated") {
      throw new Error("unexpected scheduler settings read");
    }
    const automation = s.automation;
    if (!isRecord(automation) || typeof automation.inboxTasks !== "boolean" || typeof automation.agentCron !== "boolean" || typeof automation.scriptCron !== "boolean") {
      throw new Error("unexpected scheduler settings read");
    }
    if (
      asOptionalPositiveIntOrNull(s.pollIntervalSeconds) === "invalid" ||
      asOptionalPositiveIntOrNull(s.staleAfterSeconds) === "invalid" ||
      asOptionalPositiveIntOrNull(s.maxConcurrentAgents) === "invalid" ||
      asMode(s.deviceId) === "invalid"
    ) {
      throw new Error("unexpected scheduler settings read");
    }
    return {
      available: true,
      value: {
        present: s.present as boolean,
        legacyMasterGate: s.legacyMasterGate as "absent" | "ignored" | "gated",
        automation: {
          inboxTasks: automation.inboxTasks as boolean,
          agentCron: automation.agentCron as boolean,
          scriptCron: automation.scriptCron as boolean,
        },
        deviceIdConfigured: s.deviceIdConfigured as boolean,
        pollIntervalSeconds: s.pollIntervalSeconds as number | null,
        staleAfterSeconds: s.staleAfterSeconds as number | null,
        maxConcurrentAgents: s.maxConcurrentAgents as number | null,
        deviceId: s.deviceId as string | null,
      },
    };
  }
  if (typeof json.reason !== "string" || json.reason === "") {
    throw new Error("unexpected scheduler settings read");
  }
  return { available: false, reason: json.reason };
}

/** Fail-closed parser for the agent-preference read projection. */
export function parseAgentPreferencesRead(json: unknown): SettingsReadResult<AgentPreferencesProjection> {
  if (!isRecord(json) || typeof json.available !== "boolean") {
    throw new Error("unexpected agent settings read");
  }
  if (json.available === true) {
    return { available: true, value: parseAgentPreferencesProjection(json) };
  }
  if (typeof json.reason !== "string" || json.reason === "") {
    throw new Error("unexpected agent settings read");
  }
  return { available: false, reason: json.reason };
}

function parseAgentPreferencesProjection(json: Record<string, unknown>): AgentPreferencesProjection {
  const model = json.model;
  if (!isRecord(model)) throw new Error("unexpected agent settings read");
  if (asStringOrNull(model.id) === "invalid" || asStringOrNull(model.thinking) === "invalid") {
    throw new Error("unexpected agent settings read");
  }
  const fallback = json.modelFallback;
  if (!isRecord(fallback)) throw new Error("unexpected agent settings read");
  if (typeof fallback.declared !== "boolean" || asBooleanOrNull(fallback.autoSwitch) === "invalid" || asCount(fallback.modelCount) === "invalid") {
    throw new Error("unexpected agent settings read");
  }
  if (asStringList(fallback.models) === "invalid") throw new Error("unexpected agent settings read");
  const contextInjection = json.contextInjection;
  if (!isRecord(contextInjection) || asMode(contextInjection.mode) === "invalid") {
    throw new Error("unexpected agent settings read");
  }
  const selfImprovement = json.selfImprovement;
  if (!isRecord(selfImprovement) || asBooleanOrNull(selfImprovement.autoNudge) === "invalid" || asBooleanOrNull(selfImprovement.reviewLoopEnabled) === "invalid") {
    throw new Error("unexpected agent settings read");
  }
  const reviewLoop = selfImprovement.reviewLoop;
  if (!isRecord(reviewLoop) || asOptionalPositiveIntOrNull(reviewLoop.intervalTurns) === "invalid" || asOptionalPositiveIntOrNull(reviewLoop.recentMessages) === "invalid" || asOptionalPositiveIntOrNull(reviewLoop.timeoutMs) === "invalid") {
    throw new Error("unexpected agent settings read");
  }
  return {
    model: { id: model.id as string | null, thinking: model.thinking as string | null },
    modelFallback: {
      declared: fallback.declared as boolean,
      autoSwitch: fallback.autoSwitch as boolean | null,
      modelCount: fallback.modelCount as number,
      models: fallback.models as string[],
    },
    contextInjection: { mode: contextInjection.mode as string | null },
    selfImprovement: {
      autoNudge: selfImprovement.autoNudge as boolean | null,
      reviewLoopEnabled: selfImprovement.reviewLoopEnabled as boolean | null,
      reviewLoop: {
        intervalTurns: reviewLoop.intervalTurns as number | null,
        recentMessages: reviewLoop.recentMessages as number | null,
        timeoutMs: reviewLoop.timeoutMs as number | null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// W6 closed write intent builders
// ---------------------------------------------------------------------------

export interface SchedulerSettingsPatchInput {
  automation?: { inbox_tasks?: boolean; agent_cron?: boolean; script_cron?: boolean };
  pollIntervalSeconds?: number;
  staleAfterSeconds?: number;
  maxConcurrentAgents?: number;
  deviceId?: string | null;
}

export interface AgentModelPatchInput {
  id?: string;
  thinking?: string;
}

export interface AgentModelFallbackPatchInput {
  autoSwitch?: boolean;
  models?: string[];
}

export interface AgentSelfImprovementPatchInput {
  autoNudge?: boolean;
  reviewLoopEnabled?: boolean;
  reviewLoopIntervalTurns?: number;
  reviewLoopRecentMessages?: number;
  reviewLoopTimeoutMs?: number;
}

export function buildSchedulerSettingsEnvelope(block: SchedulerSettingsPatchInput): Record<string, unknown> {
  return { surface: "local", family: "scheduler", block };
}

export function buildAgentModelEnvelope(agent: string, block: AgentModelPatchInput): Record<string, unknown> {
  return { surface: "agent", agent, family: "model", block };
}

export function buildAgentModelFallbackEnvelope(
  agent: string,
  block: AgentModelFallbackPatchInput,
  confirmAutoSwitch: boolean,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = { surface: "agent", agent, family: "model-fallback", block };
  if (confirmAutoSwitch) envelope.confirmAutoSwitch = true;
  return envelope;
}

export function buildAgentContextInjectionEnvelope(agent: string, mode: "per_turn" | "session_start_only"): Record<string, unknown> {
  return { surface: "agent", agent, family: "context-injection", mode };
}

export function buildAgentSelfImprovementEnvelope(agent: string, block: AgentSelfImprovementPatchInput): Record<string, unknown> {
  return { surface: "agent", agent, family: "self-improvement", block };
}

// ---------------------------------------------------------------------------
// W6 structural input validation
// ---------------------------------------------------------------------------

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const CONTEXT_INJECTION_MODES = ["per_turn", "session_start_only"] as const;

export function isValidThinkingLevel(value: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isValidContextInjectionMode(value: string): boolean {
  return (CONTEXT_INJECTION_MODES as readonly string[]).includes(value);
}

/** Mirror of the delivered FALLBACK_MODEL_ID_PATTERN (provider/modelId grammar). */
const FALLBACK_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

export function isValidFallbackModelId(value: string): boolean {
  return FALLBACK_MODEL_ID_PATTERN.test(value);
}

/** Bounded review-loop numeric field (positive safe integer), or null when blank. */
export function parseOptionalPositiveInt(input: string): number | null | "invalid" {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return "invalid";
  return value;
}
