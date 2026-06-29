import { type BootstrapOptions } from "./bootstrap.js";
export type SetupStatus = "ok" | "warn" | "fail";
export interface SetupCheck {
    id: string;
    status: SetupStatus;
    message: string;
}
export interface SetupReport {
    ok: boolean;
    configPath: string;
    piHome: string;
    agentName?: string;
    agentDir?: string;
    vaultRoot?: string;
    allowedAgents: string[];
    excludedAgents: string[];
    checks: SetupCheck[];
}
export interface SetupPirenOptions extends BootstrapOptions {
    piHome?: string | undefined;
    apply?: boolean | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    thinking?: string | undefined;
    apiKey?: string | undefined;
}
export declare function setupPiren(options?: SetupPirenOptions): Promise<SetupReport>;
export declare function formatSetupReport(report: SetupReport): string;
