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
export type SettingsFoundationErrorCode = "not-found" | "malformed-config" | "invalid-intent" | "invalid-agent" | "revision-changed" | "write-failed" | "read-failed";
/** Bounded non-secret foundation error. `message` never carries config content or secrets. */
export declare class SettingsFoundationError extends Error {
    readonly code: SettingsFoundationErrorCode;
    constructor(code: SettingsFoundationErrorCode, message: string);
}
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
export declare function createNodeSettingsFoundationIo(): SettingsFoundationIo;
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
    automation?: {
        inbox_tasks?: boolean;
        agent_cron?: boolean;
        script_cron?: boolean;
    };
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
export type LocalSettingsIntent = {
    surface: "local";
    family: "telegram";
    block: TelegramSettingsPatch;
} | {
    surface: "local";
    family: "discord";
    block: DiscordSettingsPatch;
} | {
    surface: "local";
    family: "scheduler";
    block: SchedulerSettingsPatch;
};
export type AgentSettingsIntent = {
    surface: "agent";
    agent: string;
    family: "model";
    block: AgentModelPatch;
} | {
    surface: "agent";
    agent: string;
    family: "model-fallback";
    block: AgentModelFallbackPatch;
    /** W6: explicit route-specific confirmation required when the save leaves auto-switch enabled. */
    confirmAutoSwitch?: boolean;
} | {
    surface: "agent";
    agent: string;
    family: "context-injection";
    mode: "per_turn" | "session_start_only";
} | {
    surface: "agent";
    agent: string;
    family: "self-improvement";
    block: AgentSelfImprovementPatch;
};
export type SettingsIntent = LocalSettingsIntent | AgentSettingsIntent;
export type ParseIntentResult = {
    ok: true;
    intent: SettingsIntent;
} | {
    ok: false;
    error: string;
};
/**
 * Parse a raw value into the CLOSED Settings intent model. Unknown kinds,
 * surfaces, families, and block fields are rejected. A patch must change at
 * least one field. Errors are bounded and never echo supplied secret values.
 */
export declare function parseSettingsIntent(raw: unknown): ParseIntentResult;
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
    automation: {
        inboxTasks: boolean;
        agentCron: boolean;
        scriptCron: boolean;
    };
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
    model?: {
        id: string | null;
        thinking: string | null;
    };
    modelFallback?: {
        declared: boolean;
        autoSwitch: boolean | null;
        modelCount: number;
        /** W6: the editable fallback declaration list (empty when undeclared). */
        models: string[];
    };
    contextInjection?: {
        mode: string | null;
    };
    selfImprovement?: {
        autoNudge: boolean | null;
        reviewLoopEnabled: boolean | null;
        /** W6: the editable bounded review-loop numeric values (null = absent). */
        reviewLoop: {
            intervalTurns: number | null;
            recentMessages: number | null;
            timeoutMs: number | null;
        };
    };
}
/**
 * Read and project the local config with secrets and unknown fields removed.
 * The projection never includes bot tokens, the gateway token, provider
 * credentials, raw config/YAML, unknown fields, or recoverable fingerprints.
 * Missing/malformed config fails closed with a bounded non-secret reason;
 * reads never create directories or files.
 */
export declare function readLocalConfigRedacted(io: SettingsFoundationIo, configPath: string): Promise<RedactedLocalConfigProjection>;
/** Validate an agent name for vault-owned agent-config access (closed form, no traversal). */
export declare function assertValidAgentName(agent: string): void;
/** Resolve the validated `team/<agent>/config.yml` path, contained under the vault. */
export declare function agentConfigPath(vaultRoot: string, agent: string): string;
/**
 * Read and project one agent's vault-owned config with unknown fields
 * removed. The projection is bounded: model id/thinking (non-secret),
 * fallback declaration count and switch (never model id lists), context
 * injection mode, self-improvement flags. Missing/malformed config fails
 * closed; reads never create anything.
 */
export declare function readAgentConfigRedacted(io: SettingsFoundationIo, vaultRoot: string, agent: string): Promise<RedactedAgentConfigProjection>;
/** Owner-only mode for config documents (they may carry bot tokens). */
export declare const SETTINGS_CONFIG_FILE_MODE = 384;
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
export declare function writeFileAtomicChecked(io: SettingsFoundationIo, path: string, content: string, options: WriteAtomicOptions): Promise<void>;
export interface ApplySettingsResult {
    wrote: true;
    surface: "local" | "agent";
    family: string;
}
export interface ApplySettingsDeps {
    nowMs?: () => number;
}
/**
 * Apply one closed local Settings intent to `~/.config/piren/config.yml`:
 * read (fail-closed), merge only the declared inventory keys into the
 * target family block (unprompted fields and unknown keys survive), render
 * the full document, prove the round-trip, and atomically write with a
 * revision check. A supplied write-only secret flows only into the document
 * — never into the result, logs, or errors.
 */
export declare function applyLocalSettingsIntent(io: SettingsFoundationIo, configPath: string, intent: LocalSettingsIntent, deps?: ApplySettingsDeps): Promise<ApplySettingsResult>;
/**
 * Apply one closed agent Settings intent to `team/<agent>/config.yml`:
 * validated path containment, strict raw read contract (missing/malformed
 * fails closed, nothing is created as a side effect), per-key merge that
 * preserves unknown fields, round-trip proof, atomic revision-checked write.
 */
export declare function applyAgentSettingsIntent(io: SettingsFoundationIo, vaultRoot: string, intent: AgentSettingsIntent, deps?: ApplySettingsDeps): Promise<ApplySettingsResult>;
