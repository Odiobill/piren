export interface VaultReadResult {
    path: string;
    absolutePath: string;
    content: string;
    bytes: number;
    mtimeMs: number;
}
export interface VaultCachedReadResult {
    path: string;
    cachePath: string;
    content: string;
    bytes: number;
    mtimeMs: number;
    cached: true;
    authoritative: false;
}
export interface VaultWriteResult {
    path: string;
    absolutePath: string;
    bytes: number;
    atomic: true;
    queued: false;
    degraded: false;
    authoritative: true;
}
export interface VaultQueuedWriteResult {
    queued: true;
    degraded: true;
    authoritative: false;
    originalPath: string;
    outboxPath: string;
    bytes: number;
    reason: string;
    timestamp: string;
}
export interface VaultPatchResult {
    path: string;
    absolutePath: string;
    bytes: number;
    replacements: number;
    atomic: true;
}
export interface VaultAppendLogResult {
    path: string;
    absolutePath: string;
    bytes: number;
    bytesAppended: number;
    timestamp: string;
    atomic: true;
}
export interface VaultListEntry {
    name: string;
    path: string;
    type: "file" | "directory" | "other";
    bytes?: number;
    mtimeMs: number;
}
export interface VaultListResult {
    path: string;
    absolutePath: string;
    entries: VaultListEntry[];
}
export interface VaultTools {
    vaultRead(path: string): Promise<VaultReadResult>;
    vaultReadCached(path: string): Promise<VaultCachedReadResult>;
    vaultWrite(path: string, content: string): Promise<VaultWriteResult | VaultQueuedWriteResult>;
    vaultList(path: string): Promise<VaultListResult>;
    vaultPatch(path: string, oldText: string, newText: string): Promise<VaultPatchResult>;
    vaultAppendLog(path: string, entry: string): Promise<VaultAppendLogResult>;
}
export declare function assertInside(baseDir: string, target: string): void;
export declare function resolveVaultPath(vaultRoot: string, inputPath: string): {
    absolutePath: string;
    vaultPath: string;
};
export declare function createVaultTools(options: {
    vaultRoot: string;
    now?: () => Date;
    localOutboxDir?: string;
    localCacheDir?: string;
}): VaultTools;
