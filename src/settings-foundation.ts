/**
 * W4 (0.2.0 amendment §5/§5.1; ADR-0046): server-side Settings config
 * foundation — the atomic/redacted closed typed writer core.
 *
 * This module is a pure/testable foundation with injected filesystem and
 * clock seams. It owns:
 *
 *  1. A CLOSED discriminated intent model for the future Tier A local-config
 *     and agent-config workflows. Unknown kinds/fields are rejected; this is
 *     never a generic YAML/JSON/object patcher and never permits
 *     outside-inventory keys.
 *  2. Redacted read/projection helpers: projections never include bot
 *     tokens, the gateway token, provider credentials, raw config/YAML,
 *     unknown fields, or recoverable token fingerprints. Missing/unreadable/
 *     malformed config fails closed with bounded non-secret diagnostics, and
 *     reads never create directories.
 *  3. An atomic write primitive for a fully rendered, parser-round-tripped
 *     document: temp file in the same directory, restrictive permissions,
 *     fsync/write/rename discipline, best-effort cleanup that never masks
 *     the original error, no partial file, and a source-byte revision check
 *     that refuses to clobber a changed file.
 *  4. Typed local-config and vault-owned agent-config mutation adapters.
 *     Accepted values are structural/non-secret; a supplied secret (a
 *     write-only bot token) flows only into the written document and is
 *     never read-returned or logged.
 *
 * W4 exposes NOTHING through HTTP/CLI/UI: no gateway route, no API client,
 * no SettingsView behavior. Direct unit-test/injected callers only.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolve as resolvePath } from "node:path";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { parseModelFallbackConfig } from "./model-fallback-config.js";

// ---------------------------------------------------------------------------
// Bounded non-secret errors
// ---------------------------------------------------------------------------

export type SettingsFoundationErrorCode =
  | "not-found"
  | "malformed-config"
  | "invalid-intent"
  | "invalid-agent"
  | "revision-changed"
  | "write-failed"
  | "read-failed";

/** Bounded non-secret foundation error. `message` never carries config content or secrets. */
export class SettingsFoundationError extends Error {
  readonly code: SettingsFoundationErrorCode;
  constructor(code: SettingsFoundationErrorCode, message: string) {
    super(message);
    this.name = "SettingsFoundationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** Filesystem seam. `readFile` must reject with an ENOENT-coded error on missing files. */
export interface SettingsFoundationIo {
  readFile(path: string): Promise<string>;
  /** Create/replace a file with the given content and exact mode. */
  writeFile(path: string, content: string, mode: number): Promise<void>;
  /** fsync an existing file. */
  fsync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Production adapter over node:fs/promises (temp+fsync+rename discipline lives below). */
export function createNodeSettingsFoundationIo(): SettingsFoundationIo {
  return {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content, mode) => writeFile(path, content, { encoding: "utf8", mode }),
    async fsync(path) {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename,
    unlink,
  };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

// ---------------------------------------------------------------------------
// 1. Closed intent model
// ---------------------------------------------------------------------------

export interface TelegramSettingsPatch {
  botToken?: string;
  allowedChatIds?: number[];
  defaultAgent?: string;
  feedbackEnabled?: boolean;
}

export interface DiscordSettingsPatch {
  botToken?: string;
  allowedGuildIds?: string[];
  allowedChannelIds?: string[];
  allowedThreadIds?: string[];
  allowedDmUserIds?: string[];
  defaultAgent?: string;
  feedbackEnabled?: boolean;
}

export interface SchedulerSettingsPatch {
  enabled?: boolean;
  automation?: { inbox_tasks?: boolean; agent_cron?: boolean; script_cron?: boolean };
  pollIntervalSeconds?: number;
  staleAfterSeconds?: number;
  maxConcurrentAgents?: number;
  /** Explicit null clears the configured device id. */
  deviceId?: string | null;
}

export interface AgentModelPatch {
  id?: string;
  thinking?: string;
}

export interface AgentModelFallbackPatch {
  autoSwitch?: boolean;
  models?: string[];
}

export interface AgentSelfImprovementPatch {
  autoNudge?: boolean;
  reviewLoopEnabled?: boolean;
  reviewLoopIntervalTurns?: number;
  reviewLoopRecentMessages?: number;
  reviewLoopTimeoutMs?: number;
}

export type LocalSettingsIntent =
  | { surface: "local"; family: "telegram"; block: TelegramSettingsPatch }
  | { surface: "local"; family: "discord"; block: DiscordSettingsPatch }
  | { surface: "local"; family: "scheduler"; block: SchedulerSettingsPatch };

export type AgentSettingsIntent =
  | { surface: "agent"; agent: string; family: "model"; block: AgentModelPatch }
  | {
      surface: "agent";
      agent: string;
      family: "model-fallback";
      block: AgentModelFallbackPatch;
      /** W6: explicit route-specific confirmation required when the save leaves auto-switch enabled. */
      confirmAutoSwitch?: boolean;
    }
  | { surface: "agent"; agent: string; family: "context-injection"; mode: "per_turn" | "session_start_only" }
  | { surface: "agent"; agent: string; family: "self-improvement"; block: AgentSelfImprovementPatch };

export type SettingsIntent = LocalSettingsIntent | AgentSettingsIntent;

export type ParseIntentResult = { ok: true; intent: SettingsIntent } | { ok: false; error: string };

const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEVICE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A declared structured config block must be a mapping; null/scalars fail closed. */
function isPresentNonRecord(value: unknown): boolean {
  return value !== undefined && !isRecord(value);
}

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key)).sort();
}

function asOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined | "invalid" {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : "invalid";
}

function asOptionalNonEmptyString(record: Record<string, unknown>, key: string): string | undefined | "invalid" {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() !== "" ? value : "invalid";
}

function asOptionalPositiveInt(record: Record<string, unknown>, key: string): number | undefined | "invalid" {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : "invalid";
}

function asOptionalIntList(record: Record<string, unknown>, key: string): number[] | undefined | "invalid" {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "invalid";
  if (value.length === 0) return "invalid";
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) return "invalid";
  }
  return [...new Set(value as number[])];
}

function asOptionalStringList(record: Record<string, unknown>, key: string): string[] | undefined | "invalid" {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "invalid";
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") return "invalid";
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function hasAnyKey(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => record[key] !== undefined);
}

const TELEGRAM_KEYS = ["botToken", "allowedChatIds", "defaultAgent", "feedbackEnabled"] as const;
const DISCORD_KEYS = [
  "botToken",
  "allowedGuildIds",
  "allowedChannelIds",
  "allowedThreadIds",
  "allowedDmUserIds",
  "defaultAgent",
  "feedbackEnabled",
] as const;
const SCHEDULER_KEYS = [
  "enabled",
  "automation",
  "pollIntervalSeconds",
  "staleAfterSeconds",
  "maxConcurrentAgents",
  "deviceId",
] as const;
const AUTOMATION_KEYS = ["inbox_tasks", "agent_cron", "script_cron"] as const;
const MODEL_KEYS = ["id", "thinking"] as const;
const FALLBACK_KEYS = ["autoSwitch", "models"] as const;
const SELF_IMPROVEMENT_KEYS = [
  "autoNudge",
  "reviewLoopEnabled",
  "reviewLoopIntervalTurns",
  "reviewLoopRecentMessages",
  "reviewLoopTimeoutMs",
] as const;

function parseTelegramBlock(block: Record<string, unknown>): TelegramSettingsPatch | "invalid" {
  const patch: TelegramSettingsPatch = {};
  const botToken = block.botToken;
  if (botToken !== undefined) {
    if (typeof botToken !== "string" || botToken.trim() === "") return "invalid";
    patch.botToken = botToken;
  }
  const chatIds = asOptionalIntList(block, "allowedChatIds");
  if (chatIds === "invalid") return "invalid";
  if (chatIds !== undefined) patch.allowedChatIds = chatIds;
  const defaultAgent = asOptionalNonEmptyString(block, "defaultAgent");
  if (defaultAgent === "invalid") return "invalid";
  if (defaultAgent !== undefined) patch.defaultAgent = defaultAgent;
  const feedback = asOptionalBoolean(block, "feedbackEnabled");
  if (feedback === "invalid") return "invalid";
  if (feedback !== undefined) patch.feedbackEnabled = feedback;
  return patch;
}

function parseDiscordBlock(block: Record<string, unknown>): DiscordSettingsPatch | "invalid" {
  const patch: DiscordSettingsPatch = {};
  const botToken = block.botToken;
  if (botToken !== undefined) {
    if (typeof botToken !== "string" || botToken.trim() === "") return "invalid";
    patch.botToken = botToken;
  }
  for (const key of ["allowedGuildIds", "allowedChannelIds", "allowedThreadIds", "allowedDmUserIds"] as const) {
    const list = asOptionalStringList(block, key);
    if (list === "invalid") return "invalid";
    if (list !== undefined) patch[key] = list;
  }
  const defaultAgent = asOptionalNonEmptyString(block, "defaultAgent");
  if (defaultAgent === "invalid") return "invalid";
  if (defaultAgent !== undefined) patch.defaultAgent = defaultAgent;
  const feedback = asOptionalBoolean(block, "feedbackEnabled");
  if (feedback === "invalid") return "invalid";
  if (feedback !== undefined) patch.feedbackEnabled = feedback;
  return patch;
}

function parseSchedulerBlock(block: Record<string, unknown>): SchedulerSettingsPatch | "invalid" {
  const patch: SchedulerSettingsPatch = {};
  const enabled = asOptionalBoolean(block, "enabled");
  if (enabled === "invalid") return "invalid";
  if (enabled !== undefined) patch.enabled = enabled;
  const automation = block.automation;
  if (automation !== undefined) {
    if (!isRecord(automation)) return "invalid";
    if (unknownKeys(automation, AUTOMATION_KEYS).length > 0) return "invalid";
    if (!hasAnyKey(automation, AUTOMATION_KEYS)) return "invalid";
    const closed: NonNullable<SchedulerSettingsPatch["automation"]> = {};
    for (const key of AUTOMATION_KEYS) {
      const value = automation[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return "invalid";
      closed[key] = value;
    }
    patch.automation = closed;
  }
  for (const key of ["pollIntervalSeconds", "staleAfterSeconds", "maxConcurrentAgents"] as const) {
    const value = asOptionalPositiveInt(block, key);
    if (value === "invalid") return "invalid";
    if (value !== undefined) patch[key] = value;
  }
  const deviceId = block.deviceId;
  if (deviceId !== undefined) {
    if (deviceId === null) {
      patch.deviceId = null;
    } else if (typeof deviceId === "string" && DEVICE_ID_PATTERN.test(deviceId)) {
      patch.deviceId = deviceId;
    } else {
      return "invalid";
    }
  }
  return patch;
}

/**
 * Parse a raw value into the CLOSED Settings intent model. Unknown kinds,
 * surfaces, families, and block fields are rejected. A patch must change at
 * least one field. Errors are bounded and never echo supplied secret values.
 */
export function parseSettingsIntent(raw: unknown): ParseIntentResult {
  if (!isRecord(raw)) return { ok: false, error: "Settings intent must be an object." };
  const surface = raw.surface;
  const family = raw.family;
  if (surface !== "local" && surface !== "agent") {
    return { ok: false, error: "Unknown Settings intent surface." };
  }

  if (surface === "local") {
    if (unknownKeys(raw, ["surface", "family", "block"]).length > 0) {
      return { ok: false, error: "Unknown field(s) in the local Settings intent envelope (closed inventory)." };
    }
    const block = raw.block;
    if (!isRecord(block)) return { ok: false, error: "Settings intent block must be an object." };
    if (family === "telegram") {
      if (unknownKeys(block, TELEGRAM_KEYS).length > 0) {
        return { ok: false, error: "Unknown field(s) in the telegram Settings block (closed inventory)." };
      }
      if (!hasAnyKey(block, TELEGRAM_KEYS)) return { ok: false, error: "The telegram Settings block changes nothing." };
      const patch = parseTelegramBlock(block);
      if (patch === "invalid") return { ok: false, error: "Invalid value in the telegram Settings block." };
      return { ok: true, intent: { surface: "local", family: "telegram", block: patch } };
    }
    if (family === "discord") {
      if (unknownKeys(block, DISCORD_KEYS).length > 0) {
        return { ok: false, error: "Unknown field(s) in the discord Settings block (closed inventory)." };
      }
      if (!hasAnyKey(block, DISCORD_KEYS)) return { ok: false, error: "The discord Settings block changes nothing." };
      const patch = parseDiscordBlock(block);
      if (patch === "invalid") return { ok: false, error: "Invalid value in the discord Settings block." };
      return { ok: true, intent: { surface: "local", family: "discord", block: patch } };
    }
    if (family === "scheduler") {
      if (unknownKeys(block, SCHEDULER_KEYS).length > 0) {
        return { ok: false, error: "Unknown field(s) in the scheduler Settings block (closed inventory)." };
      }
      if (!hasAnyKey(block, SCHEDULER_KEYS)) return { ok: false, error: "The scheduler Settings block changes nothing." };
      const patch = parseSchedulerBlock(block);
      if (patch === "invalid") return { ok: false, error: "Invalid value in the scheduler Settings block." };
      return { ok: true, intent: { surface: "local", family: "scheduler", block: patch } };
    }
    return { ok: false, error: "Unknown local Settings family." };
  }

  // surface === "agent"
  const agent = raw.agent;
  if (typeof agent !== "string" || !AGENT_NAME_PATTERN.test(agent) || agent.includes("..")) {
    return { ok: false, error: "Invalid agent name for an agent Settings intent." };
  }
  if (family === "context-injection") {
    if (unknownKeys(raw, ["surface", "agent", "family", "mode"]).length > 0) {
      return { ok: false, error: "Unknown field(s) in the context-injection Settings intent envelope (closed inventory)." };
    }
    const mode = raw.mode;
    if (mode !== "per_turn" && mode !== "session_start_only") {
      return { ok: false, error: "context-injection mode must be 'per_turn' or 'session_start_only'." };
    }
    return { ok: true, intent: { surface: "agent", agent, family: "context-injection", mode } };
  }
  const envelopeKeys =
    family === "model-fallback"
      ? ["surface", "agent", "family", "block", "confirmAutoSwitch"]
      : ["surface", "agent", "family", "block"];
  if (unknownKeys(raw, envelopeKeys).length > 0) {
    return { ok: false, error: "Unknown field(s) in the agent Settings intent envelope (closed inventory)." };
  }
  const block = raw.block;
  if (!isRecord(block)) return { ok: false, error: "Settings intent block must be an object." };
  if (family === "model") {
    if (unknownKeys(block, MODEL_KEYS).length > 0) {
      return { ok: false, error: "Unknown field(s) in the model Settings block (closed inventory)." };
    }
    if (!hasAnyKey(block, MODEL_KEYS)) return { ok: false, error: "The model Settings block changes nothing." };
    const patch: AgentModelPatch = {};
    const id = asOptionalNonEmptyString(block, "id");
    if (id === "invalid") return { ok: false, error: "Invalid model id in the model Settings block." };
    if (id !== undefined) patch.id = id;
    const thinking = asOptionalNonEmptyString(block, "thinking");
    if (thinking === "invalid") return { ok: false, error: "Invalid thinking level in the model Settings block." };
    if (thinking !== undefined) patch.thinking = thinking;
    return { ok: true, intent: { surface: "agent", agent, family: "model", block: patch } };
  }
  if (family === "model-fallback") {
    if (unknownKeys(block, FALLBACK_KEYS).length > 0) {
      return { ok: false, error: "Unknown field(s) in the model-fallback Settings block (closed inventory)." };
    }
    if (!hasAnyKey(block, FALLBACK_KEYS)) return { ok: false, error: "The model-fallback Settings block changes nothing." };
    const autoSwitch = asOptionalBoolean(block, "autoSwitch");
    if (autoSwitch === "invalid") return { ok: false, error: "Invalid auto_switch value in the model-fallback Settings block." };
    const confirmRaw = raw.confirmAutoSwitch;
    if (confirmRaw !== undefined && typeof confirmRaw !== "boolean") {
      return { ok: false, error: "confirmAutoSwitch must be a boolean." };
    }
    // Read the models list WITHOUT dedup: duplicate detection belongs to the
    // delivered fallback parser below.
    let models: string[] | undefined;
    if (block.models !== undefined) {
      if (!Array.isArray(block.models) || block.models.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
        return { ok: false, error: "Invalid models list in the model-fallback Settings block." };
      }
      models = block.models as string[];
    }
    // Validate the declaration through the DELIVERED model-fallback rules
    // (structure, duplicates, cap) rather than re-implementing them.
    const check = parseModelFallbackConfig({
      auto_switch: autoSwitch ?? true,
      models: models ?? [],
    });
    if (!check.ok) return { ok: false, error: `Invalid model-fallback declaration: ${check.reason}` };
    const patch: AgentModelFallbackPatch = {};
    if (autoSwitch !== undefined) patch.autoSwitch = autoSwitch;
    if (models !== undefined) patch.models = models;
    const intent: AgentSettingsIntent = { surface: "agent", agent, family: "model-fallback", block: patch };
    if (confirmRaw === true) intent.confirmAutoSwitch = true;
    return { ok: true, intent };
  }
  if (family === "self-improvement") {
    if (unknownKeys(block, SELF_IMPROVEMENT_KEYS).length > 0) {
      return { ok: false, error: "Unknown field(s) in the self-improvement Settings block (closed inventory)." };
    }
    if (!hasAnyKey(block, SELF_IMPROVEMENT_KEYS)) {
      return { ok: false, error: "The self-improvement Settings block changes nothing." };
    }
    const patch: AgentSelfImprovementPatch = {};
    const autoNudge = asOptionalBoolean(block, "autoNudge");
    if (autoNudge === "invalid") return { ok: false, error: "Invalid autoNudge value." };
    if (autoNudge !== undefined) patch.autoNudge = autoNudge;
    const reviewEnabled = asOptionalBoolean(block, "reviewLoopEnabled");
    if (reviewEnabled === "invalid") return { ok: false, error: "Invalid reviewLoopEnabled value." };
    if (reviewEnabled !== undefined) patch.reviewLoopEnabled = reviewEnabled;
    for (const key of ["reviewLoopIntervalTurns", "reviewLoopRecentMessages", "reviewLoopTimeoutMs"] as const) {
      const value = asOptionalPositiveInt(block, key);
      if (value === "invalid") return { ok: false, error: `Invalid ${key} value.` };
      if (value !== undefined) patch[key] = value;
    }
    return { ok: true, intent: { surface: "agent", agent, family: "self-improvement", block: patch } };
  }
  return { ok: false, error: "Unknown agent Settings family." };
}

// ---------------------------------------------------------------------------
// 2. Redacted read/projection helpers
// ---------------------------------------------------------------------------

export interface RedactedTelegramProjection {
  configured: boolean;
  allowedChatIds: number;
  defaultAgent: string | null;
  feedbackEnabled: boolean | null;
}

export interface RedactedDiscordProjection {
  configured: boolean;
  allowedGuildIds: number;
  allowedChannelIds: number;
  allowedThreadIds: number | null;
  allowedDmUserIds: number | null;
  defaultAgent: string | null;
  /** W5: the §5.1 inventory lists feedback for both transports. */
  feedbackEnabled: boolean | null;
}

export interface RedactedSchedulerProjection {
  present: boolean;
  enabled: boolean;
  automation: { inboxTasks: boolean; agentCron: boolean; scriptCron: boolean };
  deviceIdConfigured: boolean;
  /** W6: the editable non-secret scheduler values (null = absent/default). */
  pollIntervalSeconds: number | null;
  staleAfterSeconds: number | null;
  maxConcurrentAgents: number | null;
  deviceId: string | null;
}

export interface RedactedLocalConfigProjection {
  available: boolean;
  /** Bounded non-secret reason when unavailable (never config content/paths). */
  reason?: string;
  telegram?: RedactedTelegramProjection;
  discord?: RedactedDiscordProjection;
  scheduler?: RedactedSchedulerProjection;
}

export interface RedactedAgentConfigProjection {
  available: boolean;
  reason?: string;
  model?: { id: string | null; thinking: string | null };
  modelFallback?: {
    declared: boolean;
    autoSwitch: boolean | null;
    modelCount: number;
    /** W6: the editable fallback declaration list (empty when undeclared). */
    models: string[];
  };
  contextInjection?: { mode: string | null };
  selfImprovement?: {
    autoNudge: boolean | null;
    reviewLoopEnabled: boolean | null;
    /** W6: the editable bounded review-loop numeric values (null = absent). */
    reviewLoop: { intervalTurns: number | null; recentMessages: number | null; timeoutMs: number | null };
  };
}

function asNonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asBooleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asPositiveIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function countList(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function countListOrNull(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * Read and project the local config with secrets and unknown fields removed.
 * The projection never includes bot tokens, the gateway token, provider
 * credentials, raw config/YAML, unknown fields, or recoverable fingerprints.
 * Missing/malformed config fails closed with a bounded non-secret reason;
 * reads never create directories or files.
 */
export async function readLocalConfigRedacted(
  io: SettingsFoundationIo,
  configPath: string,
): Promise<RedactedLocalConfigProjection> {
  let text: string;
  try {
    text = await io.readFile(configPath);
  } catch (error) {
    if (isEnoent(error)) {
      return { available: false, reason: "Local config is not present." };
    }
    throw new SettingsFoundationError("read-failed", "Local config could not be read.");
  }
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(text);
    if (!isRecord(parsed)) return { available: false, reason: "Local config is not a YAML mapping." };
    root = parsed;
  } catch {
    return { available: false, reason: "Local config is not parseable YAML." };
  }

  if (
    isPresentNonRecord(root.telegram) ||
    isPresentNonRecord(root.discord) ||
    isPresentNonRecord(root.scheduler)
  ) {
    return { available: false, reason: "Local config contains a malformed Settings block." };
  }

  const telegramBlock = isRecord(root.telegram) ? root.telegram : undefined;
  const discordBlock = isRecord(root.discord) ? root.discord : undefined;
  const schedulerBlock = isRecord(root.scheduler) ? root.scheduler : undefined;
  if (
    isPresentNonRecord(telegramBlock?.feedback) ||
    isPresentNonRecord(discordBlock?.feedback) ||
    isPresentNonRecord(schedulerBlock?.automation)
  ) {
    return { available: false, reason: "Local config contains a malformed Settings block." };
  }

  const telegram: RedactedTelegramProjection = {
    configured: asNonEmptyStringOrNull(telegramBlock?.bot_token) !== null,
    allowedChatIds: countList(telegramBlock?.allowed_chat_ids),
    defaultAgent: asNonEmptyStringOrNull(telegramBlock?.default_agent),
    feedbackEnabled: asBooleanOrNull(isRecord(telegramBlock?.feedback) ? telegramBlock.feedback.enabled : undefined),
  };

  const discord: RedactedDiscordProjection = {
    configured: asNonEmptyStringOrNull(discordBlock?.bot_token) !== null,
    allowedGuildIds: countList(discordBlock?.allowed_guild_ids),
    allowedChannelIds: countList(discordBlock?.allowed_channel_ids),
    allowedThreadIds: countListOrNull(discordBlock?.allowed_thread_ids),
    allowedDmUserIds: countListOrNull(discordBlock?.allowed_dm_user_ids),
    defaultAgent: asNonEmptyStringOrNull(discordBlock?.default_agent),
    feedbackEnabled: asBooleanOrNull(isRecord(discordBlock?.feedback) ? discordBlock.feedback.enabled : undefined),
  };

  const automationBlock = isRecord(schedulerBlock?.automation) ? schedulerBlock.automation : undefined;
  const scheduler: RedactedSchedulerProjection = {
    present: schedulerBlock !== undefined,
    enabled: schedulerBlock?.enabled === true,
    automation: {
      inboxTasks: automationBlock?.inbox_tasks === true,
      agentCron: automationBlock?.agent_cron === true,
      scriptCron: automationBlock?.script_cron === true,
    },
    deviceIdConfigured: asNonEmptyStringOrNull(schedulerBlock?.device_id) !== null,
    pollIntervalSeconds: asPositiveIntOrNull(schedulerBlock?.poll_interval_seconds),
    staleAfterSeconds: asPositiveIntOrNull(schedulerBlock?.stale_after_seconds),
    maxConcurrentAgents: asPositiveIntOrNull(schedulerBlock?.max_concurrent_agents),
    deviceId: asNonEmptyStringOrNull(schedulerBlock?.device_id),
  };

  return { available: true, telegram, discord, scheduler };
}

/** Validate an agent name for vault-owned agent-config access (closed form, no traversal). */
export function assertValidAgentName(agent: string): void {
  if (typeof agent !== "string" || !AGENT_NAME_PATTERN.test(agent) || agent.includes("..")) {
    throw new SettingsFoundationError("invalid-agent", "Invalid agent name.");
  }
}

/** Resolve the validated `team/<agent>/config.yml` path, contained under the vault. */
export function agentConfigPath(vaultRoot: string, agent: string): string {
  assertValidAgentName(agent);
  const agentDir = resolvePath(vaultRoot, "team", agent);
  const teamRoot = resolvePath(vaultRoot, "team");
  if (!agentDir.startsWith(teamRoot + "/")) {
    throw new SettingsFoundationError("invalid-agent", "Invalid agent name.");
  }
  return `${agentDir}/config.yml`;
}

/**
 * Read and project one agent's vault-owned config with unknown fields
 * removed. The projection is bounded: model id/thinking (non-secret),
 * fallback declaration count and switch (never model id lists), context
 * injection mode, self-improvement flags. Missing/malformed config fails
 * closed; reads never create anything.
 */
export async function readAgentConfigRedacted(
  io: SettingsFoundationIo,
  vaultRoot: string,
  agent: string,
): Promise<RedactedAgentConfigProjection> {
  const path = agentConfigPath(vaultRoot, agent);
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      return { available: false, reason: "Agent config is not present." };
    }
    throw new SettingsFoundationError("read-failed", "Agent config could not be read.");
  }
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(text);
    if (!isRecord(parsed)) return { available: false, reason: "Agent config is not a YAML mapping." };
    root = parsed;
  } catch {
    return { available: false, reason: "Agent config is not parseable YAML." };
  }

  if (
    isPresentNonRecord(root.model) ||
    isPresentNonRecord(root.context_injection) ||
    isPresentNonRecord(root.self_improvement)
  ) {
    return { available: false, reason: "Agent config contains a malformed Settings block." };
  }
  const modelBlock = isRecord(root.model) ? root.model : undefined;
  const contextBlock = isRecord(root.context_injection) ? root.context_injection : undefined;
  const selfBlock = isRecord(root.self_improvement) ? root.self_improvement : undefined;
  if (isPresentNonRecord(modelBlock?.fallback) || isPresentNonRecord(selfBlock?.review_loop)) {
    return { available: false, reason: "Agent config contains a malformed Settings block." };
  }
  const fallbackBlock = isRecord(modelBlock?.fallback) ? modelBlock.fallback : undefined;
  const reviewBlock = isRecord(selfBlock?.review_loop) ? selfBlock.review_loop : undefined;

  return {
    available: true,
    model: {
      id: asNonEmptyStringOrNull(modelBlock?.id),
      thinking: asNonEmptyStringOrNull(modelBlock?.thinking),
    },
    modelFallback: {
      declared: fallbackBlock !== undefined,
      autoSwitch: asBooleanOrNull(fallbackBlock?.auto_switch),
      modelCount: countList(fallbackBlock?.models),
      models: asStringList(fallbackBlock?.models),
    },
    contextInjection: { mode: asNonEmptyStringOrNull(contextBlock?.mode) },
    selfImprovement: {
      autoNudge: asBooleanOrNull(selfBlock?.auto_nudge),
      reviewLoopEnabled: asBooleanOrNull(reviewBlock?.enabled),
      reviewLoop: {
        intervalTurns: asPositiveIntOrNull(reviewBlock?.interval_turns),
        recentMessages: asPositiveIntOrNull(reviewBlock?.recent_messages),
        timeoutMs: asPositiveIntOrNull(reviewBlock?.timeout_ms),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Atomic write primitive (temp + fsync + rename + revision check)
// ---------------------------------------------------------------------------

/** Owner-only mode for config documents (they may carry bot tokens). */
export const SETTINGS_CONFIG_FILE_MODE = 0o600;

export interface WriteAtomicOptions {
  /**
   * The exact source bytes the mutation started from, or null when the file
   * must not exist. A mismatch (changed, appeared, or disappeared source)
   * refuses the write with a `revision-changed` error before any temp file
   * is created.
   */
  expectedSource: string | null;
  /** Clock seam for unique temp names. Production default: Date.now. */
  nowMs?: () => number;
}

/**
 * Atomically replace a config document: revision check against the expected
 * source bytes, temp file in the same directory with owner-only mode, fsync,
 * then rename. Every failure leaves the original bytes intact; temp cleanup
 * is best-effort and never masks the original error. No partial file is
 * ever visible at the target path.
 */
export async function writeFileAtomicChecked(
  io: SettingsFoundationIo,
  path: string,
  content: string,
  options: WriteAtomicOptions,
): Promise<void> {
  // 1. Revision check (before any temp file exists).
  let current: string | null;
  try {
    current = await io.readFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      current = null;
    } else {
      throw new SettingsFoundationError("read-failed", "The config file could not be re-read before writing.");
    }
  }
  if (current !== options.expectedSource) {
    throw new SettingsFoundationError(
      "revision-changed",
      "The config file changed since it was read; refusing to overwrite it. Re-read and retry.",
    );
  }

  // 2. Temp + fsync + rename, with best-effort cleanup that never masks.
  const nowMs = options.nowMs ?? (() => Date.now());
  const tmp = `${path}.tmp-${process.pid}-${nowMs()}`;
  try {
    await io.writeFile(tmp, content, SETTINGS_CONFIG_FILE_MODE);
    await io.fsync(tmp);
    await io.rename(tmp, path);
  } catch (error) {
    try {
      await io.unlink(tmp);
    } catch {
      // Best-effort cleanup: never mask the original failure.
    }
    if (error instanceof SettingsFoundationError) throw error;
    throw new SettingsFoundationError("write-failed", "The config file could not be written atomically; the original is unchanged.");
  }
}

// ---------------------------------------------------------------------------
// 4. Typed mutation adapters (direct callers only; NO HTTP/CLI/UI wiring)
// ---------------------------------------------------------------------------

export interface ApplySettingsResult {
  wrote: true;
  surface: "local" | "agent";
  family: string;
}

export interface ApplySettingsDeps {
  nowMs?: () => number;
}

/** Apply defined patch entries onto a target record under YAML key names. */
function applyPatchEntries(
  target: Record<string, unknown>,
  entries: Iterable<readonly [string, unknown]>,
): void {
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (value === null) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

/** Parse a config document fail-closed; returns {} for an absent/empty document. */
function parseConfigDocument(text: string | null, what: string): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    throw new SettingsFoundationError("malformed-config", `${what} is not parseable YAML; refusing to modify it.`);
  }
  if (!isRecord(parsed)) {
    throw new SettingsFoundationError("malformed-config", `${what} is not a YAML mapping; refusing to modify it.`);
  }
  return parsed;
}

/** Round-trip proof: the rendered document must parse back to a mapping. */
function requireExistingRecord(
  parent: Record<string, unknown>,
  key: string,
  what: string,
): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new SettingsFoundationError("malformed-config", `${what} is not a YAML mapping; refusing to modify it.`);
  }
  return { ...value };
}

function assertRoundTrip(yaml: string, what: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    throw new SettingsFoundationError("write-failed", `${what} could not be rendered safely; nothing was written.`);
  }
  if (!isRecord(parsed)) {
    throw new SettingsFoundationError("write-failed", `${what} could not be rendered safely; nothing was written.`);
  }
}

function localManagedEntries(intent: LocalSettingsIntent): Array<readonly [string, unknown]> {
  switch (intent.family) {
    case "telegram": {
      const b = intent.block;
      return [
        ["bot_token", b.botToken],
        ["allowed_chat_ids", b.allowedChatIds],
        ["default_agent", b.defaultAgent],
      ] as const;
    }
    case "discord": {
      const b = intent.block;
      return [
        ["bot_token", b.botToken],
        ["allowed_guild_ids", b.allowedGuildIds],
        ["allowed_channel_ids", b.allowedChannelIds],
        ["allowed_thread_ids", b.allowedThreadIds],
        ["allowed_dm_user_ids", b.allowedDmUserIds],
        ["default_agent", b.defaultAgent],
      ] as const;
    }
    case "scheduler": {
      const b = intent.block;
      return [
        ["enabled", b.enabled],
        ["poll_interval_seconds", b.pollIntervalSeconds],
        ["stale_after_seconds", b.staleAfterSeconds],
        ["max_concurrent_agents", b.maxConcurrentAgents],
        ["device_id", b.deviceId === null ? null : b.deviceId],
      ] as const;
    }
  }
}

/**
 * Apply one closed local Settings intent to `~/.config/piren/config.yml`:
 * read (fail-closed), merge only the declared inventory keys into the
 * target family block (unprompted fields and unknown keys survive), render
 * the full document, prove the round-trip, and atomically write with a
 * revision check. A supplied write-only secret flows only into the document
 * — never into the result, logs, or errors.
 */
export async function applyLocalSettingsIntent(
  io: SettingsFoundationIo,
  configPath: string,
  intent: LocalSettingsIntent,
  deps: ApplySettingsDeps = {},
): Promise<ApplySettingsResult> {
  let before: string | null;
  try {
    before = await io.readFile(configPath);
  } catch (error) {
    if (isEnoent(error)) {
      before = null;
    } else {
      throw new SettingsFoundationError("read-failed", "Local config could not be read.");
    }
  }
  const root = parseConfigDocument(before, "Local config");

  const familyKey = intent.family;
  const block = requireExistingRecord(root, familyKey, `Local config ${familyKey}`);
  applyPatchEntries(block, localManagedEntries(intent));

  // feedbackEnabled is a nested toggle, applied only when present in the patch.
  if (intent.family === "telegram" || intent.family === "discord") {
    const feedbackEnabled = intent.block.feedbackEnabled;
    if (feedbackEnabled !== undefined) {
      const feedback = requireExistingRecord(block, "feedback", `Local config ${intent.family}.feedback`);
      feedback.enabled = feedbackEnabled;
      block.feedback = feedback;
    }
  }
  if (intent.family === "scheduler" && intent.block.automation !== undefined) {
    const automation = requireExistingRecord(block, "automation", "Local config scheduler.automation");
    applyPatchEntries(automation, Object.entries(intent.block.automation));
    block.automation = automation;
  }

  root[familyKey] = block;
  const rendered = stringifyYaml(root);
  assertRoundTrip(rendered, "Local config");
  await writeFileAtomicChecked(io, configPath, rendered, { expectedSource: before, ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}) });
  return { wrote: true, surface: "local", family: intent.family };
}

/**
 * Apply one closed agent Settings intent to `team/<agent>/config.yml`:
 * validated path containment, strict raw read contract (missing/malformed
 * fails closed, nothing is created as a side effect), per-key merge that
 * preserves unknown fields, round-trip proof, atomic revision-checked write.
 */
export async function applyAgentSettingsIntent(
  io: SettingsFoundationIo,
  vaultRoot: string,
  intent: AgentSettingsIntent,
  deps: ApplySettingsDeps = {},
): Promise<ApplySettingsResult> {
  const path = agentConfigPath(vaultRoot, intent.agent);
  let before: string;
  try {
    before = await io.readFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      throw new SettingsFoundationError("not-found", "Agent config is not present; refusing to create it implicitly.");
    }
    throw new SettingsFoundationError("read-failed", "Agent config could not be read.");
  }
  // Strict raw contract: a missing/empty document is not a writable target.
  if (before.trim() === "") {
    throw new SettingsFoundationError("malformed-config", "Agent config is empty; refusing to modify it.");
  }
  const root = parseConfigDocument(before, "Agent config");

  switch (intent.family) {
    case "model": {
      const model = requireExistingRecord(root, "model", "Agent config model");
      applyPatchEntries(model, [
        ["id", intent.block.id],
        ["thinking", intent.block.thinking],
      ] as const);
      root.model = model;
      break;
    }
    case "model-fallback": {
      const model = requireExistingRecord(root, "model", "Agent config model");
      const fallback = requireExistingRecord(model, "fallback", "Agent config model.fallback");
      applyPatchEntries(fallback, [
        ["auto_switch", intent.block.autoSwitch],
        ["models", intent.block.models],
      ] as const);
      // Validate the complete merged declaration, including preserved values,
      // with the delivered bounded fallback parser before any write.
      if (!parseModelFallbackConfig(fallback).ok) {
        throw new SettingsFoundationError("malformed-config", "Agent model fallback declaration is invalid; refusing to modify it.");
      }
      model.fallback = fallback;
      root.model = model;
      break;
    }
    case "context-injection": {
      const block = requireExistingRecord(root, "context_injection", "Agent config context_injection");
      block.mode = intent.mode;
      root.context_injection = block;
      break;
    }
    case "self-improvement": {
      const block = requireExistingRecord(root, "self_improvement", "Agent config self_improvement");
      const b = intent.block;
      if (b.autoNudge !== undefined) block.auto_nudge = b.autoNudge;
      const reviewEntries: Array<readonly [string, unknown]> = [
        ["enabled", b.reviewLoopEnabled],
        ["interval_turns", b.reviewLoopIntervalTurns],
        ["recent_messages", b.reviewLoopRecentMessages],
        ["timeout_ms", b.reviewLoopTimeoutMs],
      ];
      if (reviewEntries.some(([, value]) => value !== undefined)) {
        const review = requireExistingRecord(block, "review_loop", "Agent config self_improvement.review_loop");
        applyPatchEntries(review, reviewEntries);
        block.review_loop = review;
      }
      root.self_improvement = block;
      break;
    }
  }

  const rendered = stringifyYaml(root);
  assertRoundTrip(rendered, "Agent config");
  await writeFileAtomicChecked(io, path, rendered, { expectedSource: before, ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}) });
  return { wrote: true, surface: "agent", family: intent.family };
}
