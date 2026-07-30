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
export declare const ALERT_MIRROR_RATE_LIMIT_MS = 5000;
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
export type AlertMirrorOutcome = "sent" | "failed" | "skipped-rate-limited" | "skipped-duplicate" | "skipped-no-sender";
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
export declare function createAlertMirrorState(): AlertMirrorState;
/**
 * Pure local-config resolution. Deterministic and fail closed: absent or
 * disabled config yields an inert result with no warnings; a configured
 * destination without its matching existing bot token is skipped with a
 * deterministic non-secret warning; an invalid `min_severity` disables
 * mirroring with a deterministic warning.
 */
export declare function resolveAlertMirrorConfig(config: LocalPirenConfig): ResolvedAlertMirrorConfig;
/**
 * Builds the complete logical notification text: `[severity] title` on the
 * first line, the vault-relative alert path on the second. The alert body is
 * appended only when `includeBody` is true. This function does NOT
 * platform-chunk; chunking lives in the M3 sender adapters.
 */
export declare function buildAlertNotificationText(input: {
    severity: AlertSeverity;
    title: string;
    path: string;
    body?: string;
    includeBody: boolean;
}): string;
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
export declare function mirrorStewardAlert(input: MirrorStewardAlertInput): Promise<AlertMirrorDelivery[]>;
