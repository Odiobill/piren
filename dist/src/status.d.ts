import type { PirenContext } from "./bootstrap.js";
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
    degradedReason?: string;
}
export interface BuildPirenStatusReportOptions {
    context: PirenContext;
    toolNames: string[];
    localOutboxDir: string;
    localCacheDir: string;
    skillCount?: number;
    packages?: string[];
}
export declare function buildPirenStatusReport(options: BuildPirenStatusReportOptions): Promise<PirenStatusReport>;
export declare function formatPirenStatusReport(report: PirenStatusReport): string;
