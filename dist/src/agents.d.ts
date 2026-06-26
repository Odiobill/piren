import type { BootstrapOptions } from "./bootstrap.js";
export interface AgentsReport {
    vaultRoot?: string;
    vaultAgents: string[];
    allowedAgents: string[];
    excludedAgents: string[];
    runnableAgents: string[];
    missingAllowedAgents: string[];
    staleVaultAgents?: string[];
    unsafePolicy?: boolean;
}
export declare function listPirenAgents(options?: BootstrapOptions): Promise<AgentsReport>;
export declare function formatAgentsReport(report: AgentsReport): string;
