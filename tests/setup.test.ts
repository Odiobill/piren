import { access, mkdtemp, mkdir, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSetupReport, setupPiren } from "../src/setup.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-setup-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren setup onboarding", () => {
  it("inspects local config, selected agent config, and Pi auth without mutating missing paths", async () => {
    const vault = join(root, "vault");
    const agentDir = join(vault, "team", "thor");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(configPath), `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);
    await writeFile(join(agentDir, "config.yml"), "model:\n  id: anthropic/claude-sonnet-4-20250514\n  thinking: medium\n");

    const report = await setupPiren({ configPath, cliAgent: "thor", piHome });

    expect(report.ok).toBe(false);
    expect(report.configPath).toBe(configPath);
    expect(report.vaultRoot).toBe(vault);
    expect(report.agentName).toBe("thor");
    expect(report.agentDir).toBe(agentDir);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-config", status: "ok" }),
      expect.objectContaining({ id: "runnable-agent-policy", status: "ok" }),
      expect.objectContaining({ id: "agent-local-config", status: "ok" }),
      expect.objectContaining({ id: "pi-settings", status: "warn" }),
      expect.objectContaining({ id: "pi-auth", status: "warn" }),
    ]));
    await expect(readdir(piHome)).rejects.toThrow();

    const output = formatSetupReport(report);
    expect(output).toContain("Piren setup");
    expect(output).toContain("config_path: " + configPath);
    expect(output).toContain("[WARN] pi-auth");
  });

  it("does not write missing local config when apply is not requested (dry-run default)", async () => {
    const vault = join(root, "vault");
    const agentDir = join(vault, "team", "thor");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "config.yml"), "model:\n  id: test\n");

    // configPath does not exist — intentionally not created
    const report = await setupPiren({ configPath, cliAgent: "thor", piHome });

    // The missing config should be a warning/fail, not silently created
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-config", status: "fail" }),
    ]));

    // Config file must NOT have been created
    let configCreated = false;
    try {
      await access(configPath);
      configCreated = true;
    } catch {
      // expected: file missing
    }
    expect(configCreated).toBe(false);
  });

  it("writes local config with vault_root and allowed_agents when apply is requested", async () => {
    const vault = join(root, "vault");
    const agentDir = join(vault, "team", "thor");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(agentDir, { recursive: true });
    await mkdir(piHome, { recursive: true });
    await writeFile(join(agentDir, "config.yml"), "model:\n  id: test\n");
    await writeFile(join(piHome, "settings.json"), "{}");
    await writeFile(join(piHome, "auth.json"), "{}");

    // --vault-root and --agent simulate CLI: piren setup --apply --vault-root /path --agent thor
    const report = await setupPiren({ configPath, cliVaultRoot: vault, cliAgent: "thor", piHome, apply: true });

    // Report should now show OK for local config (since we scaffolded it)
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-config", status: "ok" }),
      expect.objectContaining({ id: "runnable-agent-policy", status: "ok" }),
      expect.objectContaining({ id: "agent-local-config", status: "ok" }),
      expect.objectContaining({ id: "pi-settings", status: "ok" }),
      expect.objectContaining({ id: "pi-auth", status: "ok" }),
    ]));

    // Config file must exist and contain vault_root + allowed_agents
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(configPath, "utf8");
    expect(written).toContain(`vault_root: ${vault}`);
    expect(written).toContain("allowed_agents:");
    expect(written).toContain("  - thor");
  });

  it("scaffolds missing agent-local config.yml when apply is requested", async () => {
    const vault = join(root, "vault");
    const agentDir = join(vault, "team", "thor");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(agentDir, { recursive: true });
    await mkdir(piHome, { recursive: true });
    await writeFile(configPath, "vault_root: " + vault + "\n" + "allowed_agents:\n" + "  - thor\n");
    await writeFile(join(piHome, "settings.json"), "{}");
    await writeFile(join(piHome, "auth.json"), "{}");
    // agent-local config.yml is intentionally missing

    const report = await setupPiren({ configPath, cliAgent: "thor", piHome, apply: true });

    // The agent-local check should now be OK since we scaffolded it
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-local-config", status: "ok" }),
    ]));

    // Agent-local config must exist and be explicit that no model was selected.
    const written = await readFile(join(agentDir, "config.yml"), "utf8");
    expect(written).not.toContain("model: {}");
    expect(written).toContain("No model is configured yet");
    expect(written).toContain("poll_interval_active_seconds");
  });

  it("setup --apply writes requested provider, model, thinking, and Pi auth", async () => {
    const vault = join(root, "vault");
    const agentDir = join(vault, "team", "deep");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(agentDir, { recursive: true });
    await mkdir(piHome, { recursive: true });
    await writeFile(join(piHome, "settings.json"), "{}");
    await writeFile(join(piHome, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "old" } }, null, 2));

    const report = await setupPiren({
      configPath,
      cliVaultRoot: vault,
      cliAgent: "deep",
      piHome,
      apply: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "minimal",
      apiKey: "sk-deep",
    });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-config", status: "ok" }),
      expect.objectContaining({ id: "agent-local-config", status: "ok" }),
      expect.objectContaining({ id: "pi-auth", status: "ok" }),
    ]));

    const agentConfig = await readFile(join(agentDir, "config.yml"), "utf8");
    expect(agentConfig).toContain("model:");
    expect(agentConfig).toContain("id: deepseek/deepseek-v4-flash");
    expect(agentConfig).toContain("thinking: minimal");

    const auth = JSON.parse(await readFile(join(piHome, "auth.json"), "utf8"));
    expect(auth.anthropic.key).toBe("old");
    expect(auth.deepseek).toEqual({ type: "api_key", key: "sk-deep" });
    const mode = (await stat(join(piHome, "auth.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not overwrite existing agent-local config when apply is requested", async () => {
    const vault = join(root, "vault");
    const agentDir = join(vault, "team", "thor");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(agentDir, { recursive: true });
    await mkdir(piHome, { recursive: true });
    await writeFile(configPath, "vault_root: " + vault + "\n" + "allowed_agents:\n" + "  - thor\n");
    await writeFile(join(agentDir, "config.yml"), "# custom agent config\nmodel:\n  id: openai/gpt-5.2\n");
    await writeFile(join(piHome, "settings.json"), "{}");
    await writeFile(join(piHome, "auth.json"), "{}");

    const report = await setupPiren({ configPath, cliAgent: "thor", piHome, apply: true });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-local-config", status: "ok" }),
    ]));

    // Existing config must NOT be overwritten
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(join(agentDir, "config.yml"), "utf8");
    expect(written).toContain("# custom agent config");
    expect(written).toContain("openai/gpt-5.2");
  });
});
