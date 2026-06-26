import { type BootstrapOptions, type TelegramLocalConfig, type DiscordLocalConfig, type ServicesLocalConfig } from "./bootstrap.js";
import { type PackageEntryResolver } from "./packages.js";
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
}
export interface PiRuntimeCheck {
    source: "path" | "npx-latest" | "unavailable";
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
 * a transport entry is present, it warns if the transport is declared but not
 * installed, or installed but not running.
 */
export declare function checkServiceConfig(config: ServiceConfig | undefined): DoctorCheck | null;
export declare function defaultPiRuntimeChecker(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<PiRuntimeCheck>;
export declare function doctorPiren(options?: DoctorPirenOptions): Promise<DoctorReport>;
export declare function formatDoctorReport(report: DoctorReport): string;
