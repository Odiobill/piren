import { type BootstrapOptions, type TelegramLocalConfig, type DiscordLocalConfig, type ServicesLocalConfig } from "./bootstrap.js";
import { type PackageEntryResolver } from "./packages.js";
import { type VaultDirReader } from "./okf.js";
export type DoctorStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
    id: string;
    status: DoctorStatus;
    message: string;
}
export interface DoctorReport {
    ok: boolean;
    agentName?: string;
    agentDir?: string;
    vaultRoot?: string;
    allowedAgents: string[];
    excludedAgents: string[];
    packages: string[];
    checks: DoctorCheck[];
}
export interface DoctorPirenOptions extends BootstrapOptions {
    packageResolver?: PackageEntryResolver | undefined;
    piRuntimeChecker?: PiRuntimeChecker | undefined;
    vaultDirReader?: VaultDirReader | undefined;
}
export interface PiRuntimeCheck {
    source: "path" | "unavailable";
    version?: string | undefined;
    error?: string | undefined;
}
export type PiRuntimeChecker = (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => Promise<PiRuntimeCheck>;
/**
 * Validate Telegram transport config for `piren doctor`.
 *
 * Returns null when no telegram config is declared at all, so a normal doctor
 * run never depends on Telegram being configured. When a telegram block is
 * present, it warns on a missing bot_token or empty allowed_chat_ids, and on a
 * default_agent that is not in the runnable set.
 */
export declare function checkTelegramConfig(config: TelegramLocalConfig | undefined, runnableAgents?: string[]): DoctorCheck | null;
/**
 * Validate Discord transport config for `piren doctor`.
 *
 * Returns null when no discord config is declared at all, so a normal doctor
 * run never depends on Discord being configured. When a discord block is
 * present, it warns on a missing bot_token, empty guild/channel allowlists, or
 * a default_agent outside the runnable set.
 */
export declare function checkDiscordConfig(config: DiscordLocalConfig | undefined, runnableAgents?: string[]): DoctorCheck | null;
/**
 * The shape of a `services.transports.<name>` block the wizard / service CLI
 * writes into local config after install. Mirrors ServicesLocalConfig but is
 * re-declared here so the pure check has no cross-module type dependency beyond
 * the config contract.
 */
export type ServiceConfig = ServicesLocalConfig;
/**
 * Validate the service lifecycle status for `piren doctor`.
 *
 * Returns null when no `services.transports` block is declared at all, so a
 * normal doctor run never depends on service management being configured. When
 * a service target entry is present (gateway, telegram, discord, or scheduler),
 * it warns if the target is declared but not installed, or installed but not
 * running. The persisted config key is `services.transports.*` for backward
 * compatibility; user-facing wording calls these "service targets".
 */
export declare function checkServiceConfig(config: ServiceConfig | undefined): DoctorCheck | null;
/**
 * Doctor check: group membership (informational, status "ok").
 *
 * Reports which groups exist and which groups the selected agent (or allowed
 * agents) belong to. Emits no check when `agent-groups/` is missing.
 */
export declare function checkGroupMembership(vaultRoot: string, agentName?: string, runnableAgents?: string[]): Promise<DoctorCheck | null>;
/**
 * Doctor check: stale group agents (WARN).
 *
 * If any group config references an agent name that has no `team/<agent>/`
 * directory in the vault, warn. Emits no check when `agent-groups/` is missing.
 */
export declare function checkStaleGroupAgents(vaultRoot: string): Promise<DoctorCheck | null>;
/**
 * Doctor check: skill conflicts between groups the agent belongs to (WARN).
 *
 * If an agent belongs to two groups that both declare a skill with the same
 * name but different file bodies, warn. Only checks groups the agent actually
 * belongs to. Emits no check when `agent-groups/` is missing or the agent
 * belongs to ≤1 group.
 */
export declare function checkGroupSkillConflicts(vaultRoot: string, agentName: string): Promise<DoctorCheck | null>;
export declare function checkVaultOkfConformance(vaultRoot: string, options?: {
    vaultDirReader?: VaultDirReader;
    exclude?: string[];
}): Promise<DoctorCheck>;
export declare function defaultPiRuntimeChecker(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<PiRuntimeCheck>;
export declare function doctorPiren(options?: DoctorPirenOptions): Promise<DoctorReport>;
export declare function formatDoctorReport(report: DoctorReport): string;
