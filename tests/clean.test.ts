import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanPiren, formatCleanReport } from "../src/clean.js";

describe("piren clean", () => {
  let root: string;
  let configDir: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-clean-"));
    configDir = join(root, ".config", "piren");
    stateDir = join(root, ".local", "state", "piren");
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(configDir, "config.yml"), "vault_root: /tmp/vault\n");
    await mkdir(join(stateDir, "cache"), { recursive: true });
    await writeFile(join(stateDir, "cache", "test"), "cache data");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("in dry-run mode reports what would be removed without removing", async () => {
    const report = await cleanPiren({
      force: false,
      configDir,
      stateDir,
    });

    expect(report.removed).toEqual([]);
    expect(report.wouldRemove.length).toBeGreaterThan(0);
    expect(report.wouldRemove).toContain(configDir);
    expect(report.wouldRemove).toContain(stateDir);
    expect(report.dryRun).toBe(true);
  });

  it("with force removes config and state directories", async () => {
    const report = await cleanPiren({
      force: true,
      configDir,
      stateDir,
    });

    expect(report.removed.length).toBeGreaterThan(0);
    expect(report.removed).toContain(configDir);
    expect(report.removed).toContain(stateDir);
    expect(report.dryRun).toBe(false);

    // Verify actual deletion.
    const { access } = await import("node:fs/promises");
    await expect(access(configDir)).rejects.toThrow();
    await expect(access(stateDir)).rejects.toThrow();
  });

  it("reports nothing to clean when dirs are already absent", async () => {
    await rm(configDir, { recursive: true });
    await rm(stateDir, { recursive: true });

    const report = await cleanPiren({
      force: false,
      configDir: join(root, "nonexistent-config"),
      stateDir: join(root, "nonexistent-state"),
    });

    expect(report.wouldRemove.length).toBe(0);
  });

  it("formats a readable report", () => {
    const report = {
      dryRun: true,
      wouldRemove: ["/fake/config", "/fake/state"],
      removed: [] as string[],
      errors: [] as string[],
    };

    const output = formatCleanReport(report);
    expect(output).toContain("dry run");
    expect(output).toContain("would be removed");
    expect(output).toContain("/fake/config");
  });

  it("format a post-clean report with actual removals", () => {
    const report = {
      dryRun: false,
      wouldRemove: [] as string[],
      removed: ["/fake/config"],
      errors: [] as string[],
    };

    const output = formatCleanReport(report);
    expect(output).toContain("removed");
    expect(output).not.toContain("dry run");
  });
});
