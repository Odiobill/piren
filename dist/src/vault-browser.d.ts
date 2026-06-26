export interface VaultBrowserEntry {
    name: string;
    path: string;
    type: "file" | "directory" | "other";
    bytes?: number;
    mtimeMs: number;
}
export interface VaultBrowserListResult {
    path: string;
    entries: VaultBrowserEntry[];
    capped: boolean;
}
export interface VaultBrowserReadResult {
    path: string;
    content: string;
    bytes: number;
    mtimeMs: number;
    capped: boolean;
}
/**
 * List directory contents under a vault root path.
 * Dirs first, alpha-sorted, capped entries, dotfiles hidden.
 * Reuses resolveVaultPath for path-boundary enforcement.
 */
export declare function vaultBrowserList(vaultRoot: string, inputPath: string): Promise<VaultBrowserListResult>;
/**
 * Read a file under a vault root path with a size cap.
 * Reuses resolveVaultPath for path-boundary enforcement.
 */
export declare function vaultBrowserRead(vaultRoot: string, inputPath: string): Promise<VaultBrowserReadResult>;
