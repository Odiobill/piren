import type { PirenContext } from "./bootstrap.js";
import type { ContextInjectionMode } from "./context-injection.js";
export type PirenWriteMode = "authoritative-vault" | "local-outbox";
export type PirenCacheReadMode = "available-if-degraded" | "unavailable";
export interface PirenStatusReport {
    agentName: string;
    agentDir: string;
    vaultRoot: string;
    allowedAgents: string[];
    excludedAgents: string[];
    packages: string[];
    vaultAvailable: boolean;
    degraded: boolean;
    writeMode: PirenWriteMode;
    localOutboxDir: string;
    localCacheDir: string;
    cacheAvailable: boolean;
    cacheReadMode: PirenCacheReadMode;
    cacheFiles: string[];
    toolNames: string[];
    skillCount: number;
    contextInjection?: ContextInjectionMode;
    degradedReason?: string;
}
export interface BuildPirenStatusReportOptions {
    context: PirenContext;
    toolNames: string[];
    localOutboxDir: string;
    localCacheDir: string;
    skillCount?: number;
    packages?: string[];
    contextInjection?: ContextInjectionMode;
}
export declare function buildPirenStatusReport(options: BuildPirenStatusReportOptions): Promise<PirenStatusReport>;
export declare function formatPirenStatusReport(report: PirenStatusReport): string;
