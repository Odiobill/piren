import type { PirenContext } from "./bootstrap.js";
import type { ContextInjectionMode } from "./context-injection.js";
export type PirenWriteMode = "authoritative-vault" | "local-outbox";
export type PirenCacheReadMode = "available-if-degraded" | "unavailable";
/**
 * Static, non-sensitive alert-mirror status summary (ADR-0039 E1, M3).
 * Never carries destination kinds/IDs, tokens, errors, or delivery state.
 */
export interface AlertMirrorStatusSummary {
    enabled: boolean;
    destinations: number;
}
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
    alertMirror?: AlertMirrorStatusSummary;
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
    alertMirror?: AlertMirrorStatusSummary;
}
export declare function buildPirenStatusReport(options: BuildPirenStatusReportOptions): Promise<PirenStatusReport>;
export declare function formatPirenStatusReport(report: PirenStatusReport): string;
