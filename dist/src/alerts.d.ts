export type AlertSeverity = "low" | "normal" | "high" | "urgent";
export type AlertStatus = "open";
export interface CreateStewardAlertOptions {
    vaultRoot: string;
    from: string;
    title: string;
    body: string;
    severity?: AlertSeverity;
    notify?: boolean;
    now?: () => Date;
}
export interface StewardAlertResult {
    alertId: string;
    path: string;
    absolutePath: string;
    from: string;
    severity: AlertSeverity;
    status: AlertStatus;
    notify: boolean;
    bytes: number;
    created: string;
}
export declare function createStewardAlert(options: CreateStewardAlertOptions): Promise<StewardAlertResult>;
