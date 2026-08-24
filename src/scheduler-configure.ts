/**
 * Guided local scheduler configuration (`piren scheduler configure`,
 * 0.2.0 scope amendment §2, S3).
 *
 * An interactive, guided, explicit local-config writer for
 * ~/.config/piren/config.yml. It displays the current effective scheduler
 * state resolved through the S1 fail-closed resolver (the three automation
 * classes are the sole execution gates), prompts for exactly the closed
 * scheduler inventory (the three automation classes, poll/stale/concurrency
 * intervals, optional device id), shows a bounded non-secret preview of the
 * exact scheduler block, requires explicit confirmation, and writes
 * atomically.
 *
 * SGC-3 (0.2 Settings contract §4.3): the retired `scheduler.enabled`
 * master gate is gone from the inventory entirely. Configure owns the
 * operator-confirmed legacy migration: for a gated retired key (`enabled:
 * false` or a malformed value) every class resolves disabled until an
 * operator-confirmed write removes the stale key; class defaults consume
 * that fail-closed resolution, so migration never silently turns a class
 * on. An inert `enabled: true` is removed as explicit cleanup by a
 * confirmed write and never gains execution authority. Declining the write
 * leaves the source bytes unchanged.
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

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WizardPrompt } from "./prompt.js";
import { resolveSchedulerConfig } from "./scheduler-loop.js";
import type { LocalPirenConfig } from "./bootstrap.js";
import type { TransportConfigureIo } from "./transport-configure.js";
import { createNodeTransportConfigureIo } from "./transport-configure.js";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");

/** Device ids must match the claim/device validators (devices.ts/cron.ts). */
const DEVICE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The closed scheduler inventory collected by the guided flow. */
export interface SchedulerConfigureInput {
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
export function buildSchedulerConfigBlock(input: SchedulerConfigureInput): Record<string, unknown> {
  const block: Record<string, unknown> = {
    automation: {
      inbox_tasks: input.inboxTasks,
      agent_cron: input.agentCron,
      script_cron: input.scriptCron,
    },
    poll_interval_seconds: input.pollIntervalSeconds,
    stale_after_seconds: input.staleAfterSeconds,
    max_concurrent_agents: input.maxConcurrentAgents,
  };
  if (input.deviceId !== undefined && input.deviceId.trim() !== "") {
    block.device_id = input.deviceId;
  }
  return block;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

const MANAGED_SCHEDULER_KEYS = [
  "enabled",
  "automation",
  "poll_interval_seconds",
  "stale_after_seconds",
  "max_concurrent_agents",
  "device_id",
] as const;

const MANAGED_AUTOMATION_KEYS = ["inbox_tasks", "agent_cron", "script_cron"] as const;

/**
 * Merge a managed scheduler block over an existing parsed block. Unknown
 * scheduler keys (outside the declared inventory) and unknown automation
 * keys survive; managed keys are replaced. A managed `device_id` or the
 * retired `enabled` key being ABSENT from the managed block is an explicit
 * deletion marker (never a YAML null): configure never writes the retired
 * master gate, so any stale `scheduler.enabled` in the source is removed
 * by a confirmed write.
 */
export function mergeSchedulerBlock(
  existingBlock: Record<string, unknown>,
  managedBlock: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existingBlock };
  for (const key of MANAGED_SCHEDULER_KEYS) {
    if (key === "automation") continue;
    if ((key === "device_id" || key === "enabled") && !(key in managedBlock)) {
      delete merged[key];
      continue;
    }
    if (key in managedBlock) merged[key] = managedBlock[key];
  }
  const existingAutomation = asRecord(existingBlock.automation) ?? {};
  const managedAutomation = asRecord(managedBlock.automation) ?? {};
  const automation: Record<string, unknown> = { ...existingAutomation };
  for (const key of MANAGED_AUTOMATION_KEYS) {
    if (key in managedAutomation) automation[key] = managedAutomation[key];
  }
  merged.automation = automation;
  return merged;
}

/**
 * Merge one managed scheduler block into an existing local config.yml
 * document. Unrelated top-level keys survive; unknown scheduler fields
 * survive; the whole document is re-serialized so the managed block never
 * duplicates. An empty document yields a config with only the scheduler
 * block.
 */
export function mergeSchedulerIntoConfig(
  existingYaml: string,
  managedBlock: Record<string, unknown>,
): string {
  const trimmed = existingYaml.trim();
  let parsed: unknown = null;
  if (trimmed !== "") {
    try {
      parsed = parseYaml(trimmed);
    } catch {
      parsed = null;
    }
  }
  const root: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  root.scheduler = mergeSchedulerBlock(asRecord(root.scheduler) ?? {}, managedBlock);
  return stringifyYaml(root);
}

/**
 * Render the bounded non-secret preview of the merged scheduler block. The
 * scheduler inventory carries no secrets (booleans, integers, one device
 * id), so the preview is exact YAML of the scheduler block only — never
 * the whole config document.
 */
export function renderSchedulerPreview(mergedSchedulerBlock: Record<string, unknown>): string {
  return stringifyYaml({ scheduler: mergedSchedulerBlock }).trim();
}

export type PositiveIntParseResult = { ok: true; value: number } | { ok: false; error: string };

/** Parse a strictly positive integer field with a bounded error message. */
export function parsePositiveIntInput(raw: string, name: string): PositiveIntParseResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `scheduler.${name} must be a positive integer.` };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: `scheduler.${name} must be a positive integer.` };
  }
  return { ok: true, value };
}

export type DeviceIdParseResult = { ok: true; value: string | undefined } | { ok: false; error: string };

/**
 * Parse the optional device id. Blank means absent (the sanitized-hostname
 * fallback applies). A present value must match the device-id validator
 * used by the claim/device machinery, so the wizard never writes an id the
 * runtime would reject.
 */
export function parseDeviceIdInput(raw: string): DeviceIdParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!DEVICE_ID_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error:
        "scheduler.device_id is invalid: use lowercase letters, digits, and hyphens, " +
        "starting with a letter (for example 'thor' or 'pi-4'). Blank keeps the sanitized-hostname default.",
    };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Runner (impure; deps injected)
// ---------------------------------------------------------------------------

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
  /** True when a confirmed write removed a retired `scheduler.enabled` key
   * present in the source (gated-legacy migration or inert-key cleanup). */
  removedLegacyMasterKey: boolean;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

async function promptPositiveInt(
  prompt: WizardPrompt,
  log: (message: string) => void,
  message: string,
  name: string,
  current: number,
): Promise<number> {
  while (true) {
    const raw = await prompt.text(message, String(current));
    const result = parsePositiveIntInput(raw, name);
    if (result.ok) return result.value;
    log(`  ${result.error}`);
  }
}

async function promptDeviceId(
  prompt: WizardPrompt,
  log: (message: string) => void,
  current: string | undefined,
): Promise<string | undefined> {
  while (true) {
    const raw = await prompt.text(
      "Device id for this machine (blank to use the sanitized hostname)",
      current ?? "",
    );
    const result = parseDeviceIdInput(raw);
    if (result.ok) return result.value;
    log(`  ${result.error}`);
  }
}

/**
 * Run the guided scheduler configure flow. See the module docstring for the
 * full contract. Never starts/installs a service, never ticks the
 * scheduler, never contacts a platform, never writes the vault.
 */
export async function runSchedulerConfigure(
  prompt: WizardPrompt,
  deps: SchedulerConfigureDeps,
): Promise<SchedulerConfigureResult> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH;
  const io = deps.io ?? createNodeTransportConfigureIo();

  log(`This configures the local scheduler in ${configPath} only.`);
  log("Nothing is started or installed: no service action, no scheduler tick, no platform contact, no vault write.");
  log("");

  const existingText = await io.readConfig(configPath);
  let existingRoot: Record<string, unknown> = {};
  if (existingText !== null && existingText.trim() !== "") {
    // Fail closed: silently replacing an unparseable or non-mapping config
    // after confirmation would destroy unrelated local configuration.
    let parsed: unknown;
    try {
      parsed = parseYaml(existingText);
    } catch (error) {
      throw new Error(
        `Existing config at ${configPath} is not parseable YAML (${error instanceof Error ? error.message : String(error)}). Fix or back it up manually. No changes were written.`,
      );
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      throw new Error(`Existing config at ${configPath} is not parseable as a YAML mapping. Fix or back it up manually. No changes were written.`);
    }
    existingRoot = record;
  }

  // Current effective state through the S1 fail-closed resolver.
  const resolved = resolveSchedulerConfig(existingRoot as LocalPirenConfig);
  log("Current effective scheduler state (resolved):");
  log(
    `  automation: inbox_tasks=${onOff(resolved.automation.inboxTasks)} ` +
      `agent_cron=${onOff(resolved.automation.agentCron)} ` +
      `script_cron=${onOff(resolved.automation.scriptCron)}`,
  );
  log(`  poll interval: ${resolved.pollIntervalSeconds}s`);
  log(`  stale after: ${resolved.staleAfterSeconds}s`);
  log(`  max concurrent agents: ${resolved.maxConcurrentAgents}`);
  log(`  device id: ${resolved.deviceId ?? "auto (sanitized hostname)"}`);
  if (resolved.legacyMasterGate === "gated") {
    log("  legacy gate: the retired scheduler.enabled key is present; ALL automation classes resolve disabled until an operator-confirmed write below removes the retired key.");
    log("  legacy gate: class defaults are resolved disabled; a class turns on only if you explicitly choose it. The preview shows the retired key being removed.");
  } else if (resolved.legacyMasterGate === "ignored") {
    log("  legacy notice: retired scheduler.enabled=true is inert-to-ignore; a confirmed write removes it as explicit cleanup (it never adds execution).");
  }
  for (const warning of resolved.warnings) log(`  warning: ${warning}`);
  log("");

  // --- Closed classes (defaults consume the resolver; under a gated legacy
  // key every default is disabled, so migration never enables a class) ---
  const inboxTasks = await prompt.confirm(
    "Claim and execute pending inbox tasks (automation.inbox_tasks)?",
    resolved.automation.inboxTasks,
  );
  const agentCron = await prompt.confirm(
    "Claim and execute due agent-mode cron jobs (automation.agent_cron)?",
    resolved.automation.agentCron,
  );
  const scriptCron = await prompt.confirm(
    "Execute due script-mode cron jobs directly (automation.script_cron)?",
    resolved.automation.scriptCron,
  );

  // --- Intervals + device id ---
  const pollIntervalSeconds = await promptPositiveInt(
    prompt, log, "Poll interval in seconds between ticks", "poll_interval_seconds", resolved.pollIntervalSeconds,
  );
  const staleAfterSeconds = await promptPositiveInt(
    prompt, log, "Device staleness threshold in seconds", "stale_after_seconds", resolved.staleAfterSeconds,
  );
  const maxConcurrentAgents = await promptPositiveInt(
    prompt, log, "Maximum concurrent agents (effective concurrency stays 1)", "max_concurrent_agents", resolved.maxConcurrentAgents,
  );
  const deviceId = await promptDeviceId(prompt, log, resolved.deviceId);

  // --- Build, merge, preview, confirm ---
  const input: SchedulerConfigureInput = {
    inboxTasks,
    agentCron,
    scriptCron,
    pollIntervalSeconds,
    staleAfterSeconds,
    maxConcurrentAgents,
  };
  if (deviceId !== undefined) input.deviceId = deviceId;
  const managedBlock = buildSchedulerConfigBlock(input);
  const mergedYaml = mergeSchedulerIntoConfig(existingText ?? "", managedBlock);

  log("");
  log(`The following managed scheduler patch will be written to ${configPath} (unmanaged fields remain unchanged):`);
  // Preview only the managed inventory. Preserved unknown scheduler fields are
  // not part of this patch and must never be echoed through this bounded,
  // non-secret operator surface.
  log(renderSchedulerPreview(managedBlock)
    .split("\n")
    .map((line) => "  " + line)
    .join("\n"));
  log("");
  const confirmWrite = await prompt.confirm("Write this configuration?", true);
  if (!confirmWrite) {
    log("Cancelled. No changes were written.");
    return { configPath, wrote: false, cancelled: true, removedLegacyMasterKey: false };
  }

  await io.writeConfigAtomic(configPath, mergedYaml);
  log(`Wrote ${configPath}.`);

  // Validate the written document by re-resolving it (round-trip proof).
  const writtenResolved = resolveSchedulerConfig(parseYaml(mergedYaml) as LocalPirenConfig);
  log(
    `Validation: resolves inbox_tasks=${onOff(writtenResolved.automation.inboxTasks)} ` +
      `agent_cron=${onOff(writtenResolved.automation.agentCron)} ` +
      `script_cron=${onOff(writtenResolved.automation.scriptCron)}`,
  );
  log("");
  log("Next steps (nothing has been started):");
  log("  piren scheduler --dry-run   # preview what a tick would do");
  log("  piren scheduler             # explicit opt-in loop; Ctrl-C to stop");
  log("Installing or starting the service remains a separate explicit action: piren service install scheduler");

  return {
    configPath,
    wrote: true,
    cancelled: false,
    removedLegacyMasterKey: resolved.legacyMasterGate !== "absent",
  };
}
