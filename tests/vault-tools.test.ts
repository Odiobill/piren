import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVaultTools } from "../src/vault-tools.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-vault-tools-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "team", "thor", "logs"), { recursive: true });
  await writeFile(join(vault, "steward-directives.md"), "# Steward\n");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("vault tools", () => {
  it("reads files relative to the vault root and returns metadata", async () => {
    const tools = createVaultTools({ vaultRoot: vault });

    const result = await tools.vaultRead("steward-directives.md");

    expect(result.content).toBe("# Steward\n");
    expect(result.path).toBe("steward-directives.md");
    expect(result.absolutePath).toBe(join(vault, "steward-directives.md"));
    expect(result.bytes).toBe(Buffer.byteLength("# Steward\n"));
  });

  it("writes atomically inside the vault and leaves no temp file", async () => {
    const tools = createVaultTools({ vaultRoot: vault });

    const result = await tools.vaultWrite("team/thor/logs/spike-test.md", "spike ok\n");

    if (!("path" in result)) throw new Error("expected authoritative write");
    expect(result.path).toBe("team/thor/logs/spike-test.md");
    expect(result.bytes).toBe(Buffer.byteLength("spike ok\n"));
    await expect(readFile(join(vault, result.path), "utf8")).resolves.toBe("spike ok\n");
    await expect(stat(join(vault, "team", "thor", "logs", ".spike-test.md.tmp"))).rejects.toThrow();
  });

  it("rejects traversal outside the vault for reads and writes", async () => {
    const tools = createVaultTools({ vaultRoot: vault });

    await expect(tools.vaultRead("../outside.md")).rejects.toThrow(/outside vault/i);
    await expect(tools.vaultWrite("../outside.md", "nope")).rejects.toThrow(/outside vault/i);
  });

  it("lists files and directories inside the vault with metadata", async () => {
    const tools = createVaultTools({ vaultRoot: vault });
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki", "note.md"), "# Note\n");

    const result = await tools.vaultList(".");

    expect(result.path).toBe("");
    expect(result.entries).toEqual([
      expect.objectContaining({ name: "steward-directives.md", path: "steward-directives.md", type: "file" }),
      expect.objectContaining({ name: "team", path: "team", type: "directory" }),
      expect.objectContaining({ name: "wiki", path: "wiki", type: "directory" }),
    ]);
    expect(result.entries.find((entry) => entry.path === "steward-directives.md")?.bytes).toBe(Buffer.byteLength("# Steward\n"));
  });

  it("patches one exact text occurrence atomically inside the vault", async () => {
    const tools = createVaultTools({ vaultRoot: vault });
    await writeFile(join(vault, "team", "thor", "logs", "note.md"), "alpha\nbeta\ngamma\n");

    const result = await tools.vaultPatch("team/thor/logs/note.md", "beta", "BETA");

    expect(result.path).toBe("team/thor/logs/note.md");
    expect(result.replacements).toBe(1);
    expect(result.bytes).toBe(Buffer.byteLength("alpha\nBETA\ngamma\n"));
    await expect(readFile(join(vault, "team", "thor", "logs", "note.md"), "utf8")).resolves.toBe("alpha\nBETA\ngamma\n");
  });

  it("appends timestamped log entries inside the vault", async () => {
    const tools = createVaultTools({ vaultRoot: vault, now: () => new Date("2026-06-22T10:00:00.000Z") });

    const result = await tools.vaultAppendLog("team/thor/logs/activity.md", "Started task");

    expect(result.path).toBe("team/thor/logs/activity.md");
    expect(result.bytesAppended).toBe(Buffer.byteLength("\n## 2026-06-22T10:00:00.000Z\nStarted task\n"));
    await expect(readFile(join(vault, "team", "thor", "logs", "activity.md"), "utf8")).resolves.toBe("\n## 2026-06-22T10:00:00.000Z\nStarted task\n");
  });

  it("queues proposed writes to a local outbox when the vault is unavailable", async () => {
    const localOutbox = join(root, "local-outbox");
    const tools = createVaultTools({
      vaultRoot: join(root, "missing-vault"),
      localOutboxDir: localOutbox,
      now: () => new Date("2026-06-22T11:00:00.000Z"),
    });

    const result = await tools.vaultWrite("team/thor/logs/offline.md", "offline proposal\n");

    if (!("outboxPath" in result)) throw new Error("expected queued write");
    expect(result.queued).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.originalPath).toBe("team/thor/logs/offline.md");
    expect(result.outboxPath).toMatch(/20260622T110000000Z-team-thor-logs-offline-md\.md$/);
    await expect(readFile(result.outboxPath, "utf8")).resolves.toContain("original_path: team/thor/logs/offline.md");
    await expect(readFile(result.outboxPath, "utf8")).resolves.toContain("offline proposal");
    await expect(stat(join(root, "missing-vault", "team", "thor", "logs", "offline.md"))).rejects.toThrow();
  });
});
