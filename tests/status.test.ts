import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPirenContext } from "../src/bootstrap.js";
import { buildPirenStatusReport, formatPirenStatusReport } from "../src/status.js";

let root: string;
let vault: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-status-"));
  vault = join(root, "vault");
  agentDir = join(vault, "team", "thor");
  await mkdir(join(agentDir, "logs"), { recursive: true });
  await mkdir(join(agentDir, "inbox"), { recursive: true });
  await mkdir(join(agentDir, "outbox"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  await writeFile(join(vault, "steward-directives.md"), "# Steward\n");
  await writeFile(join(agentDir, "SOUL.md"), "# Thor\n");
  await writeFile(join(agentDir, "MEMORY.md"), "# Memory\n");
  await writeFile(join(agentDir, "config.yml"), "model: {}\n");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren status report", () => {
  it("summarizes the selected agent, policy, vault availability, tools, and write mode", async () => {
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\nexcluded_agents:\n  - loki\n`);
    const context = await loadPirenContext({ cliAgent: "thor", env: {}, configPath });

    const report = await buildPirenStatusReport({
      context,
      toolNames: ["vault_write", "vault_read"],
      localOutboxDir: join(root, "local-outbox"),
      localCacheDir: join(root, "local-cache"),
    });

    expect(report.agentName).toBe("thor");
    expect(report.agentDir).toBe(agentDir);
    expect(report.vaultRoot).toBe(vault);
    expect(report.allowedAgents).toEqual(["thor"]);
    expect(report.excludedAgents).toEqual(["loki"]);
    expect(report.vaultAvailable).toBe(true);
    expect(report.degraded).toBe(false);
    expect(report.writeMode).toBe("authoritative-vault");
    expect(report.localOutboxDir).toBe(join(root, "local-outbox"));
    expect(report.localCacheDir).toBe(join(root, "local-cache"));
    expect(report.cacheAvailable).toBe(false);
    expect(report.cacheReadMode).toBe("unavailable");
    expect(report.cacheFiles).toEqual([]);
    expect(report.toolNames).toEqual(["vault_read", "vault_write"]);

    const output = formatPirenStatusReport(report);
    expect(output).toContain("Piren status");
    expect(output).toContain("agent_name: thor");
    expect(output).toContain("vault_available: true");
    expect(output).toContain("write_mode: authoritative-vault");
    expect(output).toContain("local_cache_dir: " + join(root, "local-cache"));
    expect(output).toContain("cache_available: false");
    expect(output).toContain("cache_read_mode: unavailable");
    expect(output).toContain("registered_tools: vault_read, vault_write");
  });

  it("reports local cache files when a degraded-mode cache directory exists", async () => {
    const context = await loadPirenContext({ cliAgentDir: agentDir, env: {}, configPath: join(root, "missing-config.yml") });
    const cacheDir = join(root, "local-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "steward-directives.md"), "# Cached Steward\n");
    await writeFile(join(cacheDir, "SOUL.md"), "# Cached Soul\n");

    const report = await buildPirenStatusReport({
      context,
      toolNames: ["vault_read"],
      localOutboxDir: join(root, "local-outbox"),
      localCacheDir: cacheDir,
    });

    expect(report.cacheAvailable).toBe(true);
    expect(report.cacheReadMode).toBe("available-if-degraded");
    expect(report.cacheFiles).toEqual(["SOUL.md", "steward-directives.md"]);
    expect(formatPirenStatusReport(report)).toContain("cache_files: SOUL.md, steward-directives.md");
  });

  it("reports degraded local-outbox write mode when vault markers disappear", async () => {
    const context = await loadPirenContext({ cliAgentDir: agentDir, env: {}, configPath: join(root, "missing-config.yml") });
    await rm(join(vault, ".piren-vault"));
    await rm(join(vault, "steward-directives.md"));

    const report = await buildPirenStatusReport({
      context,
      toolNames: ["vault_write"],
      localOutboxDir: join(root, "local-outbox"),
      localCacheDir: join(root, "local-cache"),
    });

    expect(report.vaultAvailable).toBe(false);
    expect(report.degraded).toBe(true);
    expect(report.writeMode).toBe("local-outbox");
    expect(report.degradedReason).toMatch(/missing Piren vault markers/);
  });
});
