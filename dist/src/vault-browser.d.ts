/** Closed bounded list ordering (WUX-B). */
export type VaultBrowserOrdering = "name" | "recent";
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
 * Default ordering: dirs first, alpha-sorted. The optional WUX-B "recent"
 * ordering sorts ALL entries by server-derived mtimeMs descending with a
 * deterministic name tie-break BEFORE the bounded entry trim, so it can
 * expose recent items beyond the default alphabetical window.
 * Dotfiles hidden; capped entries; reuses resolveVaultPath for path-boundary
 * enforcement.
 */
export declare function vaultBrowserList(vaultRoot: string, inputPath: string, ordering?: VaultBrowserOrdering): Promise<VaultBrowserListResult>;
/**
 * Read a file under a vault root path with a size cap.
 * Reuses resolveVaultPath for path-boundary enforcement.
 */
export declare function vaultBrowserRead(vaultRoot: string, inputPath: string): Promise<VaultBrowserReadResult>;
