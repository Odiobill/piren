export interface InitVaultOptions {
    vaultRoot: string;
    agentName?: string;
    force?: boolean;
}
export interface InitVaultResult {
    vaultRoot: string;
    agentName: string;
    agentDir: string;
    created: string[];
}
export declare function initVault(options: InitVaultOptions): Promise<InitVaultResult>;
