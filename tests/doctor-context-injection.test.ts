import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkContextInjectionConfig, doctorPiren, type PiRuntimeCheck } from "../src/doctor.js";
import { initVault } from "../src/init.js";

let root: string;

const localPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "path", version: "0.80.2" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-doctor-ci-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("checkContextInjectionConfig (pure)", () => {
  it("returns null for a missing/malformed config (null) and for a missing block", () => {
    expect(checkContextInjectionConfig(null)).toBeNull();
    expect(checkContextInjectionConfig({})).toBeNull();
    expect(checkContextInjectionConfig({ model: { id: "x" } })).toBeNull();
  });

  it("reports ok for valid per_turn and session_start_only blocks", () => {
    expect(checkContextInjectionConfig({ context_injection: { mode: "per_turn" } })).toEqual({
      id: "context-injection",
      status: "ok",
      message: expect.stringContaining("per_turn"),
    });
    expect(checkContextInjectionConfig({ context_injection: { mode: "session_start_only" } })).toEqual({
      id: "context-injection",
      status: "ok",
      message: expect.stringContaining("session_start_only"),
    });
  });

  it("warns on an unknown mode value, naming the value", () => {
    const check = checkContextInjectionConfig({ context_injection: { mode: "session_start" } });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("session_start");
  });

  it("warns on a non-map context_injection block", () => {
    const check = checkContextInjectionConfig({ context_injection: "session_start_only" });
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("context_injection");
  });

  it("supports a per-agent check id for the all-agent doctor path", () => {
    const check = checkContextInjectionConfig({ context_injection: { mode: "bogus" } }, "context-injection:thor");
    expect(check?.id).toBe("context-injection:thor");
    expect(check?.status).toBe("warn");
  });
});

describe("piren doctor context-injection wiring", () => {
  it("warns on an invalid mode in the selected agent's config.yml", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await writeFile(join(root, "team", "thor", "config.yml"), "context_injection:\n  mode: session_start\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "context-injection", status: "warn", message: expect.stringContaining("session_start") }),
    ]));
  });

  it("reports ok for a valid block and stays quiet when the block is absent", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await writeFile(join(root, "team", "thor", "config.yml"), "context_injection:\n  mode: session_start_only\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const withBlock = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    expect(withBlock.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "context-injection", status: "ok", message: expect.stringContaining("session_start_only") }),
    ]));

    await writeFile(join(root, "team", "thor", "config.yml"), "model: {}\n");
    const withoutBlock = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    expect(withoutBlock.checks.find((check) => check.id === "context-injection")).toBeUndefined();
  });

  it("stays quiet for a malformed agent config (existing separate gap, not broadened)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await writeFile(join(root, "team", "thor", "config.yml"), "context_injection:\n  mode: [unclosed\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks.find((check) => check.id === "context-injection")).toBeUndefined();
  });

  it("never consults PIREN_CONTEXT_INJECTION: valid config stays ok and absent block stays quiet", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    // Invalid env override must not turn a valid config into a warning.
    await writeFile(join(root, "team", "thor", "config.yml"), "context_injection:\n  mode: session_start_only\n");
    const validConfig = await doctorPiren({ cliAgent: "thor", env: { PIREN_CONTEXT_INJECTION: "bogus" }, configPath, piRuntimeChecker: localPiRuntime });
    const check = validConfig.checks.find((entry) => entry.id === "context-injection");
    expect(check?.status).toBe("ok");

    // Valid env override must not make an absent block produce a check at all.
    await writeFile(join(root, "team", "thor", "config.yml"), "model: {}\n");
    const absentBlock = await doctorPiren({ cliAgent: "thor", env: { PIREN_CONTEXT_INJECTION: "session_start_only" }, configPath, piRuntimeChecker: localPiRuntime });
    expect(absentBlock.checks.find((entry) => entry.id === "context-injection")).toBeUndefined();
  });

  it("checks every enabled agent in the all-agent path with per-agent check ids", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "heimdall", force: true });
    await writeFile(join(root, "team", "heimdall", "config.yml"), "context_injection:\n  mode: bogus\n");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n  - heimdall\n`);

    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "context-injection:heimdall", status: "warn", message: expect.stringContaining("bogus") }),
    ]));
    expect(report.checks.find((check) => check.id === "context-injection:thor")).toBeUndefined();
  });
});
