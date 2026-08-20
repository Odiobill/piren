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
