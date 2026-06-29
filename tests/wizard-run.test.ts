import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWizard } from "../src/wizard.js";
import type { WizardPrompt } from "../src/prompt.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-wizard-run-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function fakePrompt(answers: {
  vaultPath?: string;
  firstAgent?: string;
  selectedAgents?: string[];
  excludedAgents?: string[];
  confirmWrite?: boolean;
}): WizardPrompt {
  return {
    async text(message: string, defaultValue?: string) {
      if (message.toLowerCase().includes("vault")) return answers.vaultPath ?? defaultValue ?? "";
      if (message.toLowerCase().includes("agent")) return answers.firstAgent ?? defaultValue ?? "piren";
      return defaultValue ?? "";
    },
    async secret() {
      throw new Error("first-run setup must not ask for provider secrets");
    },
    async confirm(message: string, defaultValue?: boolean) {
      if (message.toLowerCase().includes("write")) return answers.confirmWrite ?? true;
      return defaultValue ?? false;
    },
    async select() {
      throw new Error("first-run setup must not show provider or gateway menus");
    },
    async list(message: string, defaults?: string[]) {
      if (message.toLowerCase().includes("exclude")) return answers.excludedAgents ?? [];
      return answers.selectedAgents ?? defaults ?? [];
    },
  };
}

const piInstalled = async () => ({ ok: true as const, command: "pi", version: "0.79.9" });
const piMissing = async () => ({ ok: false as const });

async function seedPiAuth(piHome: string): Promise<void> {
  await mkdir(piHome, { recursive: true });
  await writeFile(join(piHome, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }, null, 2));
}

async function seedPiSettings(piHome: string): Promise<void> {
  await mkdir(piHome, { recursive: true });
  await writeFile(
    join(piHome, "settings.json"),
    JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-v4-pro", defaultThinkingLevel: "high" }, null, 2),
  );
}

describe("runWizard: first-run preflight", () => {
  it("exits before prompting or mutating when pi is missing", async () => {
    const vault = join(root, "newvault");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    const logs: string[] = [];

    const result = await runWizard(fakePrompt({ vaultPath: vault, firstAgent: "piren" }), {
      configPath,
      piHome,
      piCommandChecker: piMissing,
      log: (m) => logs.push(m),
    });

    expect(result.completed).toBe(false);
    expect(result.exitReason).toBe("missing-pi");
    expect(logs.join("\n")).toContain("curl -fsSL https://pi.dev/install.sh | sh");
    await expect(access(configPath)).rejects.toThrow();
    await expect(access(vault)).rejects.toThrow();
  });

  it("exits before vault creation when Pi auth is not configured", async () => {
    const vault = join(root, "newvault");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    const logs: string[] = [];

    const result = await runWizard(fakePrompt({ vaultPath: vault, firstAgent: "piren" }), {
      configPath,
      piHome,
      piCommandChecker: piInstalled,
      log: (m) => logs.push(m),
    });

    expect(result.completed).toBe(false);
    expect(result.exitReason).toBe("pi-not-configured");
    expect(logs.join("\n")).toContain("pi");
    expect(logs.join("\n")).toContain("/login");
    expect(logs.join("\n")).toContain("/quit");
    expect(logs.join("\n")).toContain("piren setup");
    await expect(access(configPath)).rejects.toThrow();
    await expect(access(vault)).rejects.toThrow();
  });
});

describe("runWizard: minimal first-run setup", () => {
  it("initializes a new vault and writes local Piren config plus Pi default model", async () => {
    const vault = join(root, "newvault");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    const logs: string[] = [];
    await seedPiAuth(piHome);
    await seedPiSettings(piHome);

    const result = await runWizard(fakePrompt({ vaultPath: vault, firstAgent: "piren" }), {
      configPath,
      piHome,
      piCommandChecker: piInstalled,
      log: (m) => logs.push(m),
    });

    expect(result.completed).toBe(true);
    expect(result.newVault).toBe(true);
    expect(result.vaultRoot).toBe(vault);
    expect(result.allowedAgents).toEqual(["piren"]);
    expect(result.wroteAuthJson).toBe(false);
    expect(result.wroteAgentConfig).toBe(true);
    expect(result.configuredTransports).toEqual([]);
    await expect(access(join(vault, ".piren-vault"))).resolves.toBeUndefined();
    await expect(access(join(vault, "team", "piren", "SOUL.md"))).resolves.toBeUndefined();

    const configContent = await readFile(configPath, "utf8");
    expect(configContent).toContain(`vault_root: ${vault}`);
    expect(configContent).toContain("- piren");

    const agentConfig = await readFile(join(vault, "team", "piren", "config.yml"), "utf8");
    expect(agentConfig).toContain("model:");
    expect(agentConfig).toContain("id: deepseek/deepseek-v4-pro");
    expect(agentConfig).toContain("thinking: high");
    expect(agentConfig).toContain("Change this per-agent model anytime");

    const logText = logs.join("\n");
    expect(logText).toContain("piren status");
    expect(logText).toContain("piren run");
    expect(logText).toContain("piren service install gateway");
    expect(logText).toContain("piren service install telegram");
    expect(logText).toContain("piren service install discord");
  });

  it("reuses an existing vault and lets the operator select local runnable agents", async () => {
    const vault = join(root, "existing");
    await mkdir(join(vault, "team", "thor"), { recursive: true });
    await mkdir(join(vault, "team", "sage"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await seedPiAuth(piHome);

    const result = await runWizard(
      fakePrompt({ vaultPath: vault, selectedAgents: ["thor"], excludedAgents: ["sage"] }),
      { configPath, piHome, piCommandChecker: piInstalled, log: () => {} },
    );

    expect(result.completed).toBe(true);
    expect(result.newVault).toBe(false);
    expect(result.allowedAgents).toEqual(["thor"]);
    expect(result.excludedAgents).toEqual(["sage"]);

    const configContent = await readFile(configPath, "utf8");
    expect(configContent).toContain("- thor");
    expect(configContent).toContain("excluded_agents:");
    expect(configContent).toContain("- sage");
  });
});
