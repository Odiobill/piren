import type { AlertSeverity } from "./alerts.js";
import type { LocalPirenConfig } from "./bootstrap.js";

/**
 * Pure steward-alert mirror core (ADR-0039 E1, slice M1).
 *
 * The vault alert file is the only authoritative alert record. This module
 * resolves the opt-in local `alert_mirror:` configuration, builds the minimal
 * notification payload, and performs best-effort delivery through injected
 * senders. It performs no filesystem, network, or config reads of its own and
 * never throws for delivery failures: every expected outcome is a normalized
 * delivery record.
 */

/** Fixed per-destination minimum send interval. Drop-not-queue; not configurable in E1. */
export const ALERT_MIRROR_RATE_LIMIT_MS = 5000;

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

const ALERT_SEVERITIES = new Set<string>(["low", "normal", "high", "urgent"]);

export interface AlertMirrorDestination {
  kind: "telegram" | "discord";
  /** Destination identifier (chat_id or channel_id) as a string. Local-only; never reported. */
  id: string;
}

export interface ResolvedAlertMirrorConfig {
  enabled: boolean;
  minSeverity: AlertSeverity;
  includeBody: boolean;
  destinations: AlertMirrorDestination[];
  /** Deterministic, non-secret configuration warnings. */
  warnings: string[];
}

export interface AlertMirrorSenders {
  telegram?: ((chatId: string, text: string) => Promise<void>) | undefined;
  discord?: ((channelId: string, text: string) => Promise<void>) | undefined;
}

export type AlertMirrorOutcome =
  | "sent"
  | "failed"
  | "skipped-rate-limited"
  | "skipped-duplicate"
  | "skipped-no-sender";

export interface AlertMirrorDelivery {
  destination: AlertMirrorDestination;
  outcome: AlertMirrorOutcome;
  /** Normalized fixed reason only; never raw exception text, tokens, or IDs. */
  reason?: string;
}

/**
 * Process-local dedupe/rate-limit state. Deliberately ephemeral: a restart may
 * re-send at most alerts re-flagged after restart; the vault alert file remains
 * authoritative. Injected so tests control it fully.
 */
export interface AlertMirrorState {
  seenAlertIds: Set<string>;
  /** Per-destination epoch ms of the last successful send, keyed by `kind:id`. */
  lastSentAt: Map<string, number>;
}

export function createAlertMirrorState(): AlertMirrorState {
  return { seenAlertIds: new Set(), lastSentAt: new Map() };
}

function disabledMirror(warnings: string[] = []): ResolvedAlertMirrorConfig {
  return { enabled: false, minSeverity: "low", includeBody: false, destinations: [], warnings };
}

function resolveDestinationId(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function hasToken(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Pure local-config resolution. Deterministic and fail closed: absent or
 * disabled config yields an inert result with no warnings; a configured
 * destination without its matching existing bot token is skipped with a
 * deterministic non-secret warning; an invalid `min_severity` disables
 * mirroring with a deterministic warning.
 */
export function resolveAlertMirrorConfig(config: LocalPirenConfig): ResolvedAlertMirrorConfig {
  const block = config.alert_mirror;
  if (!block || block.enabled !== true) {
    return disabledMirror();
  }

  const warnings: string[] = [];
  let minSeverity: AlertSeverity = "low";
  if (block.min_severity !== undefined) {
    const raw = block.min_severity as string;
    if (typeof raw === "string" && ALERT_SEVERITIES.has(raw)) {
      minSeverity = raw as AlertSeverity;
    } else {
      warnings.push("alert_mirror: invalid min_severity; mirroring disabled (use low, normal, high, or urgent)");
      return disabledMirror(warnings);
    }
  }

  const destinations: AlertMirrorDestination[] = [];
  const telegramId = resolveDestinationId(block.telegram?.chat_id);
  if (telegramId !== undefined) {
    if (hasToken(config.telegram?.bot_token)) {
      destinations.push({ kind: "telegram", id: telegramId });
    } else {
      warnings.push("alert_mirror: telegram destination configured but telegram.bot_token is missing; destination skipped");
    }
  }
  const discordId = resolveDestinationId(block.discord?.channel_id);
  if (discordId !== undefined) {
    if (hasToken(config.discord?.bot_token)) {
      destinations.push({ kind: "discord", id: discordId });
    } else {
      warnings.push("alert_mirror: discord destination configured but discord.bot_token is missing; destination skipped");
    }
  }

  return {
    enabled: true,
    minSeverity,
    includeBody: block.include_body === true,
    destinations,
    warnings,
  };
}

/**
 * Builds the complete logical notification text: `[severity] title` on the
 * first line, the vault-relative alert path on the second. The alert body is
 * appended only when `includeBody` is true. This function does NOT
 * platform-chunk; chunking lives in the M3 sender adapters.
 */
export function buildAlertNotificationText(input: {
  severity: AlertSeverity;
  title: string;
  path: string;
  body?: string;
  includeBody: boolean;
}): string {
  const head = `[${input.severity}] ${input.title}\n${input.path}`;
  if (input.includeBody && typeof input.body === "string" && input.body.trim() !== "") {
    return `${head}\n\n${input.body}`;
  }
  return head;
}

export interface MirrorStewardAlertInput {
  alertId: string;
  severity: AlertSeverity;
  title: string;
  path: string;
  body: string;
  notify: boolean;
  config: ResolvedAlertMirrorConfig;
  senders: AlertMirrorSenders;
  state: AlertMirrorState;
  now?: () => Date;
}

/**
 * Best-effort advisory mirror of an already-written alert. Runs only after
 * the authoritative alert write has succeeded. Never throws: sender rejections
 * become normalized `failed` records. No-op cases (`notify: false`, disabled
 * config, below-floor severity) return `[]` and do not mutate dedupe or
 * rate-limit state. Delivery is drop-not-queue with a fixed per-destination
 * rate limit; the per-destination timestamp updates only after a successful
 * send. One destination's failure or rate limit never prevents other
 * destinations from being attempted.
 */
export async function mirrorStewardAlert(input: MirrorStewardAlertInput): Promise<AlertMirrorDelivery[]> {
  if (!input.notify) return [];
  const config = input.config;
  if (!config.enabled || config.destinations.length === 0) return [];
  if (SEVERITY_ORDER[input.severity] < SEVERITY_ORDER[config.minSeverity]) return [];

  if (input.state.seenAlertIds.has(input.alertId)) {
    return config.destinations.map((destination) => ({
      destination,
      outcome: "skipped-duplicate" as const,
      reason: "alert already mirrored in this process",
    }));
  }
  input.state.seenAlertIds.add(input.alertId);

  const text = buildAlertNotificationText({
    severity: input.severity,
    title: input.title,
    path: input.path,
    body: input.body,
    includeBody: config.includeBody,
  });
  const now = (input.now ?? (() => new Date()))().getTime();

  const deliveries: AlertMirrorDelivery[] = [];
  for (const destination of config.destinations) {
    const sender = destination.kind === "telegram" ? input.senders.telegram : input.senders.discord;
    if (!sender) {
      deliveries.push({
        destination,
        outcome: "skipped-no-sender",
        reason: `no ${destination.kind} sender configured`,
      });
      continue;
    }
    const key = `${destination.kind}:${destination.id}`;
    const last = input.state.lastSentAt.get(key);
    if (last !== undefined && now - last < ALERT_MIRROR_RATE_LIMIT_MS) {
      deliveries.push({
        destination,
        outcome: "skipped-rate-limited",
        reason: "within per-destination rate limit",
      });
      continue;
    }
    try {
      await sender(destination.id, text);
      input.state.lastSentAt.set(key, now);
      deliveries.push({ destination, outcome: "sent" });
    } catch {
      deliveries.push({ destination, outcome: "failed", reason: "sender rejected" });
    }
  }
  return deliveries;
}
