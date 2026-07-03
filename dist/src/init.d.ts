export interface InitVaultOptions {
    vaultRoot: string;
    agentName?: string;
    force?: boolean;
    agentConfigContent?: string;
}
export interface InitVaultResult {
    vaultRoot: string;
    agentName: string;
    agentDir: string;
    created: string[];
}
export declare function initVault(options: InitVaultOptions): Promise<InitVaultResult>;
/**
 * Scaffold a single agent directory (team/<agent>/) inside an EXISTING vault,
 * without re-initializing the vault itself. Used by `piren agent add` so adding
 * a second agent does not trip initVault's "vault file already exists" guard.
 *
 * Creates the same subdirectories and identity files initVault writes for a
 * fresh agent: inbox/outbox/devices/logs/sessions/skills, plus SOUL.md,
 * MEMORY.md, and config.yml. Respects `force` to overwrite identity files.
 */
export declare function scaffoldAgentDirectory(options: InitVaultOptions): Promise<InitVaultResult>;
