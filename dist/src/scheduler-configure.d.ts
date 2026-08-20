/**
 * Guided local scheduler configuration (`piren scheduler configure`,
 * 0.2.0 scope amendment §2, S3).
 *
 * An interactive, guided, explicit local-config writer for
 * ~/.config/piren/config.yml. It displays the current effective scheduler
 * state resolved through the S1 fail-closed resolver (fresh installs
 * resolve disabled; a legacy established block resolves enabled=true with
 * its migration signal), prompts for exactly the closed scheduler
 * inventory (master gate, the three automation classes, poll/stale/
 * concurrency intervals, optional device id), shows a bounded non-secret
 * preview of the exact scheduler block, requires explicit confirmation,
 * and writes atomically.
 *
 * Confirming the flow after a legacy migration signal materializes
 * explicit `scheduler.enabled: true`; nothing writes before confirmation.
 * Cancellation, a parse/validation failure, or a write failure leaves the
 * old config byte-for-byte intact.
 *
 * The flow never starts/installs/stops/restarts a service, never runs or
 * ticks the scheduler, never refreshes a heartbeat, never claims or spawns
 * work, never contacts a platform, and never writes the vault.
 *
 * The pure helpers are unit-tested directly; the runner takes an injected
 * WizardPrompt and TransportConfigureIo so tests drive it with fakes. The
 * production fs adapter (shared with the transport configure flows)
 * performs the atomic temp-file + rename write with owner-only modes.
 */
import type { WizardPrompt } from "./prompt.js";
import type { TransportConfigureIo } from "./transport-configure.js";
/** The closed scheduler inventory collected by the guided flow. */
export interface SchedulerConfigureInput {
    enabled: boolean;
    inboxTasks: boolean;
    agentCron: boolean;
    scriptCron: boolean;
    pollIntervalSeconds: number;
    staleAfterSeconds: number;
    maxConcurrentAgents: number;
    /** Blank/undefined omits the key (sanitized-hostname fallback). */
    deviceId?: string;
}
/**
 * Serialize the closed typed scheduler inventory as a config block. Only
 * declared keys are produced; `device_id` is omitted when blank.
 */
export declare function buildSchedulerConfigBlock(input: SchedulerConfigureInput): Record<string, unknown>;
/**
 * Merge a managed scheduler block over an existing parsed block. Unknown
 * scheduler keys (outside the declared inventory) and unknown automation
 * keys survive; managed keys are replaced. A managed `device_id` of
 * `undefined` is an explicit deletion marker, never a YAML null.
 */
export declare function mergeSchedulerBlock(existingBlock: Record<string, unknown>, managedBlock: Record<string, unknown>): Record<string, unknown>;
/**
 * Merge one managed scheduler block into an existing local config.yml
 * document. Unrelated top-level keys survive; unknown scheduler fields
 * survive; the whole document is re-serialized so the managed block never
 * duplicates. An empty document yields a config with only the scheduler
 * block.
 */
export declare function mergeSchedulerIntoConfig(existingYaml: string, managedBlock: Record<string, unknown>): string;
/**
 * Render the bounded non-secret preview of the merged scheduler block. The
 * scheduler inventory carries no secrets (booleans, integers, one device
 * id), so the preview is exact YAML of the scheduler block only — never
 * the whole config document.
 */
export declare function renderSchedulerPreview(mergedSchedulerBlock: Record<string, unknown>): string;
export type PositiveIntParseResult = {
    ok: true;
    value: number;
} | {
    ok: false;
    error: string;
};
/** Parse a strictly positive integer field with a bounded error message. */
export declare function parsePositiveIntInput(raw: string, name: string): PositiveIntParseResult;
export type DeviceIdParseResult = {
    ok: true;
    value: string | undefined;
} | {
    ok: false;
    error: string;
};
/**
 * Parse the optional device id. Blank means absent (the sanitized-hostname
 * fallback applies). A present value must match the device-id validator
 * used by the claim/device machinery, so the wizard never writes an id the
 * runtime would reject.
 */
export declare function parseDeviceIdInput(raw: string): DeviceIdParseResult;
export interface SchedulerConfigureDeps {
    configPath?: string;
    /** Config-file IO seam. Production: createNodeTransportConfigureIo(). */
    io?: TransportConfigureIo;
    log?: (message: string) => void;
}
export interface SchedulerConfigureResult {
    configPath: string;
    wrote: boolean;
    cancelled: boolean;
    /** True when a legacy migration signal was materialized into an explicit
     * `scheduler.enabled: true` by this confirmed write. */
    materializedMigration: boolean;
}
/**
 * Run the guided scheduler configure flow. See the module docstring for the
 * full contract. Never starts/installs a service, never ticks the
 * scheduler, never contacts a platform, never writes the vault.
 */
export declare function runSchedulerConfigure(prompt: WizardPrompt, deps: SchedulerConfigureDeps): Promise<SchedulerConfigureResult>;
