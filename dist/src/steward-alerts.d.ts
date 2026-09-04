import type { AlertSeverity } from "./alerts.js";
export type StewardAlertStatus = "open" | "closed";
export interface StewardAlert {
    path: string;
    id: string;
    from: string;
    severity: AlertSeverity;
    status: StewardAlertStatus;
    created: string;
    title: string;
    closedAt?: string;
    closedVia?: "workbench";
}
export interface ParseStewardAlertOptions {
    path: string;
    content: string;
}
export interface CloseStewardAlertOptions extends ParseStewardAlertOptions {
    closedAt: string;
}
export interface CloseStewardAlertResult {
    content: string;
    alert: StewardAlert;
}
export interface StewardAlertProjection {
    attentionCount: number;
    alerts: StewardAlert[];
}
export declare function isDirectActiveStewardAlertPath(path: string): boolean;
/** Parse one direct active steward-alert file without touching the filesystem. */
export declare function parseStewardAlert(options: ParseStewardAlertOptions): StewardAlert;
/**
 * Produce the exact next document for one open alert. This is pure: callers
 * supply current file content and must perform any CAS-protected write.
 */
export declare function closeStewardAlert(options: CloseStewardAlertOptions): CloseStewardAlertResult;
/**
 * Build the bounded, deterministic gateway-owned alert projection. The count
 * is intentionally uncapped; only a future presentation may render `99+`.
 */
export declare function projectStewardAlerts(alerts: readonly StewardAlert[]): StewardAlertProjection;
