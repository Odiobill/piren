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

/** A scripted prompter that returns canned answers in order. */
function fakePrompt(answers: {
  vaultPath?: string;
  firstAgent?: string;
  setupLlm?: boolean;
  providerIndex?: number;
  apiKey?: string;
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
      return answers.apiKey ?? "";
    },
    async confirm(message: string, defaultValue?: boolean) {
      if (message.toLowerCase().includes("llm")) return answers.setupLlm ?? true;
      if (message.toLowerCase().includes("write")) return answers.confirmWrite ?? true;
      return defaultValue ?? false;
    },
    async select() {
      return answers.providerIndex ?? 0;
    },
    async list(message: string, defaults?: string[]) {
      if (message.toLowerCase().includes("exclude")) return answers.excludedAgents ?? [];
      return answers.selectedAgents ?? defaults ?? [];
    },
  };
}

describe("runWizard: new vault flow", () => {
  it("initializes a new vault, writes auth.json at 0600, and writes local config", async () => {
    const vault = join(root, "newvault");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    const logs: string[] = [];

    const result = await runWizard(fakePrompt({ vaultPath: vault, firstAgent: "piren", setupLlm: true, providerIndex: 0, apiKey: "sk-test-key" }), {
      configPath,
      piHome,
      log: (m) => logs.push(m),
    });

    expect(result.newVault).toBe(true);
    expect(result.vaultRoot).toBe(vault);
    expect(result.allowedAgents).toEqual(["piren"]);
    expect(result.providerId).toBe("anthropic");
    expect(result.wroteAuthJson).toBe(true);
    expect(result.wroteConfig).toBe(true);

    // Vault was initialized.
    await expect(access(join(vault, ".piren-vault"))).resolves.toBeUndefined();
    await expect(access(join(vault, "team", "piren", "SOUL.md"))).resolves.toBeUndefined();

    // auth.json written with the anthropic key.
    const authContent = await readFile(join(piHome, "auth.json"), "utf8");
    const auth = JSON.parse(authContent);
    expect(auth.anthropic.type).toBe("api_key");
    expect(auth.anthropic.key).toBe("sk-test-key");

    // Local config written with vault_root and allowed agent.
    const configContent = await readFile(configPath, "utf8");
    expect(configContent).toContain(`vault_root: ${vault}`);
    expect(configContent).toContain("- piren");
  });

  it("skips LLM setup when the operator declines", async () => {
    const vault = join(root, "newvault2");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");

    const result = await runWizard(fakePrompt({ vaultPath: vault, firstAgent: "piren", setupLlm: false }), {
      configPath,
      piHome,
      log: () => {},
    });

    expect(result.wroteAuthJson).toBe(false);
    expect(result.providerId).toBeUndefined();
    await expect(access(join(piHome, "auth.json"))).rejects.toThrow();
  });

  it("does not write local config when the operator declines the confirm step", async () => {
    const vault = join(root, "newvault3");
    const configPath = join(root, "config.yml");

    const result = await runWizard(fakePrompt({ vaultPath: vault, firstAgent: "piren", setupLlm: false, confirmWrite: false }), {
      configPath,
      log: () => {},
    });

    expect(result.wroteConfig).toBe(false);
    await expect(access(configPath)).rejects.toThrow();
  });
});

describe("runWizard: existing vault flow", () => {
  it("detects existing agents and lets the operator select which to enable", async () => {
    const vault = join(root, "existing");
    // Pre-seed an existing vault structure with two agents.
    await mkdir(join(vault, "team", "thor"), { recursive: true });
    await mkdir(join(vault, "team", "sage"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");

    const result = await runWizard(
      fakePrompt({ vaultPath: vault, setupLlm: false, selectedAgents: ["thor"], excludedAgents: ["sage"] }),
      { configPath, piHome, log: () => {} },
    );

    expect(result.newVault).toBe(false);
    expect(result.allowedAgents).toEqual(["thor"]);
    expect(result.excludedAgents).toEqual(["sage"]);

    const configContent = await readFile(configPath, "utf8");
    expect(configContent).toContain("- thor");
    expect(configContent).toContain("excluded_agents:");
    expect(configContent).toContain("- sage");
  });

  it("preserves an existing auth.json provider when adding a new key", async () => {
    const vault = join(root, "existing-auth");
    await mkdir(join(vault, "team", "piren"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    const configPath = join(root, "config.yml");
    const piHome = join(root, "pi-home");
    await mkdir(piHome, { recursive: true });
    await writeFile(join(piHome, "auth.json"), JSON.stringify({ google: { type: "api_key", key: "gem-old" } }, null, 2));

    const result = await runWizard(
      fakePrompt({ vaultPath: vault, setupLlm: true, providerIndex: 1, apiKey: "sk-openai-new" }), // index 1 = openai
      { configPath, piHome, log: () => {} },
    );

    expect(result.wroteAuthJson).toBe(true);
    const authContent = await readFile(join(piHome, "auth.json"), "utf8");
    const auth = JSON.parse(authContent);
    expect(auth.google.key).toBe("gem-old");
    expect(auth.openai.key).toBe("sk-openai-new");
  });
});
