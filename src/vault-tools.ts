import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

export function assertInside(baseDir: string, target: string): void {
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path resolves outside vault: ${target}`);
  }
}

export function resolveVaultPath(vaultRoot: string, inputPath: string): { absolutePath: string; vaultPath: string } {
  if (!inputPath || inputPath.trim() === "") {
    throw new Error("Vault path is required");
  }

  const root = resolve(vaultRoot);
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  assertInside(root, absolutePath);
  return { absolutePath, vaultPath: relative(root, absolutePath) };
}

async function atomicWriteFile(target: string, content: string): Promise<number> {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });

  const tempPath = resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const bytes = Buffer.byteLength(content);

  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, target);

  try {
    const dirHandle = await open(directory, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Some filesystems or platforms do not support fsync on directories.
  }

  return bytes;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertVaultAvailable(vaultRoot: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(vaultRoot);
  } catch {
    throw new Error(`Vault unavailable: ${vaultRoot}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Vault unavailable: ${vaultRoot} is not a directory`);
  }

  const hasMarker = await pathExists(join(vaultRoot, ".piren-vault"));
  const hasFallbackShape = (await pathExists(join(vaultRoot, "steward-directives.md"))) && (await pathExists(join(vaultRoot, "team")));
  if (!hasMarker && !hasFallbackShape) {
    throw new Error(`Vault unavailable: ${vaultRoot} is missing Piren vault markers`);
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function slugPath(path: string): string {
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "vault-write";
}

async function queueWrite(options: { localOutboxDir: string; path: string; content: string; reason: string; timestamp: string }): Promise<VaultQueuedWriteResult> {
  const outboxDir = resolve(options.localOutboxDir);
  const outboxPath = join(outboxDir, `${compactTimestamp(new Date(options.timestamp))}-${slugPath(options.path)}.md`);
  const proposal = [
    "---",
    "type: blocked-vault-write",
    `created: ${options.timestamp}`,
    `original_path: ${options.path}`,
    "authoritative: false",
    `reason: ${JSON.stringify(options.reason)}`,
    "---",
    "",
    "# Blocked Vault Write",
    "",
    "Piren could not write this content authoritatively to the vault. Review and apply manually if appropriate.",
    "",
    "## Proposed Content",
    "",
    "```text",
    options.content,
    "```",
    "",
  ].join("\n");
  const bytes = await atomicWriteFile(outboxPath, proposal);
  return {
    queued: true,
    degraded: true,
    authoritative: false,
    originalPath: options.path,
    outboxPath,
    bytes,
    reason: options.reason,
    timestamp: options.timestamp,
  };
}

export function createVaultTools(options: { vaultRoot: string; now?: () => Date; localOutboxDir?: string; localCacheDir?: string }): VaultTools {
  const vaultRoot = resolve(options.vaultRoot);
  const now = options.now ?? (() => new Date());
  const localOutboxDir = options.localOutboxDir ? resolve(options.localOutboxDir) : undefined;
  const localCacheDir = options.localCacheDir ? resolve(options.localCacheDir) : undefined;

  return {
    async vaultRead(path: string): Promise<VaultReadResult> {
      const resolved = resolveVaultPath(vaultRoot, path);
      const content = await readFile(resolved.absolutePath, "utf8");
      const metadata = await stat(resolved.absolutePath);
      return {
        path: resolved.vaultPath,
        absolutePath: resolved.absolutePath,
        content,
        bytes: Buffer.byteLength(content),
        mtimeMs: metadata.mtimeMs,
      };
    },

    async vaultReadCached(path: string): Promise<VaultCachedReadResult> {
      if (!localCacheDir) {
        throw new Error("Local cache directory is not configured");
      }
      const resolved = resolveVaultPath(localCacheDir, path);
      const content = await readFile(resolved.absolutePath, "utf8");
      const metadata = await stat(resolved.absolutePath);
      return {
        path: resolved.vaultPath,
        cachePath: resolved.absolutePath,
        content,
        bytes: Buffer.byteLength(content),
        mtimeMs: metadata.mtimeMs,
        cached: true,
        authoritative: false,
      };
    },

    async vaultWrite(path: string, content: string): Promise<VaultWriteResult | VaultQueuedWriteResult> {
      const resolved = resolveVaultPath(vaultRoot, path);
      try {
        await assertVaultAvailable(vaultRoot);
      } catch (error) {
        if (!localOutboxDir) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return queueWrite({ localOutboxDir, path: resolved.vaultPath, content, reason, timestamp: now().toISOString() });
      }

      let bytes: number;
      try {
        bytes = await atomicWriteFile(resolved.absolutePath, content);
      } catch (error) {
        if (!localOutboxDir) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return queueWrite({ localOutboxDir, path: resolved.vaultPath, content, reason, timestamp: now().toISOString() });
      }
      return {
        path: resolved.vaultPath,
        absolutePath: resolved.absolutePath,
        bytes,
        atomic: true,
        queued: false,
        degraded: false,
        authoritative: true,
      };
    },

    async vaultList(path: string): Promise<VaultListResult> {
      const resolved = resolveVaultPath(vaultRoot, path);
      const directoryEntries = await readdir(resolved.absolutePath, { withFileTypes: true });
      const entries: VaultListEntry[] = [];

      for (const entry of directoryEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolutePath = join(resolved.absolutePath, entry.name);
        const metadata = await stat(absolutePath);
        const vaultPath = relative(vaultRoot, absolutePath);
        const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
        const listEntry: VaultListEntry = {
          name: entry.name,
          path: vaultPath,
          type,
          mtimeMs: metadata.mtimeMs,
        };
        if (type === "file") {
          listEntry.bytes = metadata.size;
        }
        entries.push(listEntry);
      }

      return {
        path: resolved.vaultPath,
        absolutePath: resolved.absolutePath,
        entries,
      };
    },

    async vaultPatch(path: string, oldText: string, newText: string): Promise<VaultPatchResult> {
      if (oldText === "") {
        throw new Error("old_text must not be empty");
      }
      const resolved = resolveVaultPath(vaultRoot, path);
      const content = await readFile(resolved.absolutePath, "utf8");
      const first = content.indexOf(oldText);
      if (first === -1) {
        throw new Error("old_text not found");
      }
      if (content.indexOf(oldText, first + oldText.length) !== -1) {
        throw new Error("old_text must match exactly once");
      }
      const patched = content.slice(0, first) + newText + content.slice(first + oldText.length);
      const bytes = await atomicWriteFile(resolved.absolutePath, patched);
      return {
        path: resolved.vaultPath,
        absolutePath: resolved.absolutePath,
        bytes,
        replacements: 1,
        atomic: true,
      };
    },

    async vaultAppendLog(path: string, entry: string): Promise<VaultAppendLogResult> {
      const resolved = resolveVaultPath(vaultRoot, path);
      const timestamp = now().toISOString();
      const normalizedEntry = entry.endsWith("\n") ? entry.slice(0, -1) : entry;
      const appended = `\n## ${timestamp}\n${normalizedEntry}\n`;
      let existing = "";
      try {
        existing = await readFile(resolved.absolutePath, "utf8");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      const bytes = await atomicWriteFile(resolved.absolutePath, existing + appended);
      return {
        path: resolved.vaultPath,
        absolutePath: resolved.absolutePath,
        bytes,
        bytesAppended: Buffer.byteLength(appended),
        timestamp,
        atomic: true,
      };
    },
  };
}
