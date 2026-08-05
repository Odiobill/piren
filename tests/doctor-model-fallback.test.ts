import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkModelFallbackConfig, doctorPiren, type PiRuntimeCheck } from "../src/doctor.js";
import { initVault } from "../src/init.js";

let root: string;

const localPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "path", version: "0.80.2" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-doctor-mf-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

const WARN_GUIDANCE = /Authority: model fallback is an agent-local preference and doctor is read-only; doctor never switches models\. Next: inspect model\.fallback in team\/<agent>\/config\.yml\./;

describe("checkModelFallbackConfig (pure)", () => {
  it("returns null for a missing/malformed config and for an absent fallback block", () => {
    expect(checkModelFallbackConfig(null)).toBeNull();
    expect(checkModelFallbackConfig({})).toBeNull();
    expect(checkModelFallbackConfig({ model: { id: "kimi-coding/k3" } })).toBeNull();
    expect(checkModelFallbackConfig({ model: { id: "kimi-coding/k3", fallback: undefined } })).toBeNull();
  });

  it("reports ok with a count-only message for a valid fallback (no ids echoed)", () => {
    const check = checkModelFallbackConfig({
      model: {
        id: "kimi-coding/k3",
        fallback: { models: ["opencode-go/kimi-k3", "openrouter/kimi-k3"] },
      },
    });
    expect(check).not.toBeNull();
    expect(check).toEqual({
      id: "model-fallback",
      status: "ok",
      message: "model.fallback configured with 2 fallback model(s).",
    });
    if (check === null) throw new Error("unreachable");
    // Never echo model ids or raw YAML in doctor output.
    expect(check.message).not.toContain("opencode-go/kimi-k3");
    expect(check.message).not.toContain("kimi-coding/k3");
  });

  it("reports ok and keeps auto_switch:false inspectable (no automatic switching promised)", () => {
    const check = checkModelFallbackConfig({
      model: {
        id: "kimi-coding/k3",
        fallback: { auto_switch: false, models: ["opencode-go/kimi-k3"] },
      },
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("auto_switch is false");
  });

  it("warns on a present-but-invalid fallback with the deterministic cause and Authority/Next guidance", () => {
    const cases: Array<{ block: unknown; cause: RegExp }> = [
      { block: "not-a-mapping", cause: /must be a mapping/ },
      { block: null, cause: /must be a mapping/ },
      { block: {}, cause: /models must be an array/ },
      { block: { models: [] }, cause: /non-empty/ },
      { block: { models: [7] }, cause: /non-empty strings/ },
      { block: { models: ["bogus"] }, cause: /invalid model id/ },
      { block: { models: ["a/m1", "a/m1"] }, cause: /duplicate/ },
      { block: { models: ["a/m1", "a/m2", "a/m3", "a/m4", "a/m5", "a/m6"] }, cause: /maximum/ },
      { block: { auto_switch: "yes", models: ["a/m1"] }, cause: /auto_switch/ },
    ];
    for (const { block, cause } of cases) {
      const check = checkModelFallbackConfig({ model: { id: "kimi-coding/k3", fallback: block } });
      expect(check?.status).toBe("warn");
      expect(check?.message).toMatch(cause);
      expect(check?.message).toMatch(WARN_GUIDANCE);
    }
  });

  it("warns (not parser error) when a valid fallback duplicates the configured primary model.id", () => {
    const check = checkModelFallbackConfig({
      model: {
        id: "kimi-coding/k3",
        fallback: { models: ["opencode-go/kimi-k3", "kimi-coding/k3"] },
      },
    });
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/primary model\.id/);
    expect(check?.message).toMatch(WARN_GUIDANCE);
    // The warning never echoes the id itself.
    expect(check?.message).not.toContain("kimi-coding/k3");
  });

  it("supports a per-agent check id for the all-agent doctor path", () => {
    const check = checkModelFallbackConfig(
      { model: { fallback: { models: ["opencode-go/kimi-k3"] } } },
      "model-fallback:thor",
    );
    expect(check?.id).toBe("model-fallback:thor");
    expect(check?.status).toBe("ok");
  });
});

describe("piren doctor model-fallback wiring", () => {
  it("reports ok for a valid block, warns for a malformed block, and stays quiet when absent", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);

    await writeFile(
      join(root, "team", "thor", "config.yml"),
      "model:\n  id: kimi-coding/k3\n  fallback:\n    models:\n      - opencode-go/kimi-k3\n",
    );
    const valid = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    expect(valid.checks).toEqual(expect.arrayContaining([
      { id: "model-fallback", status: "ok", message: "model.fallback configured with 1 fallback model(s)." },
    ]));

    await writeFile(
      join(root, "team", "thor", "config.yml"),
      "model:\n  id: kimi-coding/k3\n  fallback:\n    models: [bogus]\n",
    );
    const malformed = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    const warn = malformed.checks.find((check) => check.id === "model-fallback");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toMatch(/invalid model id/);
    expect(warn?.message).toMatch(WARN_GUIDANCE);
    expect(warn?.message).not.toContain("bogus");

    await writeFile(join(root, "team", "thor", "config.yml"), "model:\n  id: kimi-coding/k3\n");
    const absent = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    expect(absent.checks.find((check) => check.id === "model-fallback")).toBeUndefined();
  });

  it("stays quiet for a malformed whole agent config (existing separate gap, not broadened)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n`);
    await writeFile(join(root, "team", "thor", "config.yml"), "model:\n  fallback: [unclosed\n");

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });
    expect(report.checks.find((check) => check.id === "model-fallback")).toBeUndefined();
  });

  it("checks every enabled agent in the all-agent path with per-agent check ids", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "heimdall", force: true });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, `vault_root: ${root}\nallowed_agents:\n  - thor\n  - heimdall\n`);
    await writeFile(
      join(root, "team", "heimdall", "config.yml"),
      "model:\n  id: kimi-coding/k3\n  fallback:\n    models:\n      - kimi-coding/k3\n",
    );

    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "model-fallback:heimdall", status: "warn", message: expect.stringMatching(/primary model\.id/) }),
    ]));
    // thor has no fallback block: quiet under its own id.
    expect(report.checks.find((check) => check.id === "model-fallback:thor")).toBeUndefined();
  });
});
