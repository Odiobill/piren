import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isExistingVault,
  PI_PROVIDERS,
  formatProviderMenu,
  buildAuthJsonEntry,
  serializeAuthJson,
  buildLocalConfigPatch,
  parseCommaList,
  type LocalConfigInput,
} from "../src/wizard.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-wizard-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("wizard: existing vault detection", () => {
  it("detects a directory with the .piren-vault marker as an existing vault", async () => {
    const vault = join(root, "vault");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    expect(await isExistingVault(vault)).toBe(true);
  });

  it("detects a directory with steward-directives.md plus team/ as an existing vault", async () => {
    const vault = join(root, "vault2");
    await mkdir(join(vault, "team"), { recursive: true });
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    expect(await isExistingVault(vault)).toBe(true);
  });

  it("returns false for a plain directory that is not a vault", async () => {
    const dir = join(root, "plain");
    await mkdir(dir, { recursive: true });
    expect(await isExistingVault(dir)).toBe(false);
  });

  it("returns false for a missing path", async () => {
    expect(await isExistingVault(join(root, "does-not-exist"))).toBe(false);
  });
});

describe("wizard: provider catalog", () => {
  it("includes the common providers with their env var", () => {
    expect(PI_PROVIDERS.some((p) => p.id === "anthropic" && p.envVar === "ANTHROPIC_API_KEY")).toBe(true);
    expect(PI_PROVIDERS.some((p) => p.id === "openai" && p.envVar === "OPENAI_API_KEY")).toBe(true);
    expect(PI_PROVIDERS.some((p) => p.id === "google" && p.envVar === "GEMINI_API_KEY")).toBe(true);
    expect(PI_PROVIDERS.some((p) => p.id === "deepseek" && p.envVar === "DEEPSEEK_API_KEY")).toBe(true);
  });

  it("formatProviderMenu lists each provider with a number and env hint", () => {
    const text = formatProviderMenu();
    expect(text).toContain("anthropic");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toMatch(/\d+\.\s/);
  });
});

describe("wizard: auth.json entry construction", () => {
  it("builds an api_key credential keyed by provider id", () => {
    const entry = buildAuthJsonEntry("anthropic", "sk-test-123");
    expect(entry).toEqual({ anthropic: { type: "api_key", key: "sk-test-123" } });
  });

  it("does not leak the key into a second provider's entry", () => {
    const a = buildAuthJsonEntry("anthropic", "sk-a");
    const b = buildAuthJsonEntry("openai", "sk-b");
    expect(a.anthropic?.key).toBe("sk-a");
    expect(b.openai?.key).toBe("sk-b");
    expect(a).not.toHaveProperty("openai");
  });
});

describe("wizard: auth.json serialization", () => {
  it("merges into an existing auth object without dropping other providers", () => {
    const existing = { google: { type: "api_key" as const, key: "old" } };
    const merged = serializeAuthJson(existing, buildAuthJsonEntry("anthropic", "sk-new"));
    const parsed = JSON.parse(merged);
    expect(parsed.google.key).toBe("old");
    expect(parsed.anthropic.key).toBe("sk-new");
    expect(parsed.anthropic.type).toBe("api_key");
  });

  it("produces 2-space indented JSON", () => {
    const text = serializeAuthJson({}, buildAuthJsonEntry("anthropic", "sk-x"));
    expect(text).toContain('\n  "anthropic"');
  });
});

describe("wizard: local config patch", () => {
  it("writes vault_root and a single allowed agent for a fresh setup", () => {
    const input: LocalConfigInput = {
      vaultRoot: "/srv/vault",
      allowedAgents: ["piren"],
      excludedAgents: [],
    };
    const yaml = buildLocalConfigPatch(input);
    expect(yaml).toContain("vault_root: /srv/vault");
    expect(yaml).toContain("allowed_agents:");
    expect(yaml).toContain("  - piren");
  });

  it("writes multiple allowed agents and preserves excluded agents", () => {
    const input: LocalConfigInput = {
      vaultRoot: "/srv/vault",
      allowedAgents: ["piren", "thor", "sage"],
      excludedAgents: ["legacy"],
    };
    const yaml = buildLocalConfigPatch(input);
    expect(yaml).toContain("  - piren");
    expect(yaml).toContain("  - thor");
    expect(yaml).toContain("  - sage");
    expect(yaml).toContain("excluded_agents:");
    expect(yaml).toContain("  - legacy");
  });

  it("omits the excluded_agents block when none are provided", () => {
    const input: LocalConfigInput = {
      vaultRoot: "/srv/vault",
      allowedAgents: ["piren"],
      excludedAgents: [],
    };
    expect(buildLocalConfigPatch(input)).not.toContain("excluded_agents");
  });
});

describe("wizard: comma list parsing", () => {
  it("parses a comma-separated string into trimmed values", () => {
    expect(parseCommaList("piren, thor , sage")).toEqual(["piren", "thor", "sage"]);
  });

  it("drops empty entries", () => {
    expect(parseCommaList("piren, , thor")).toEqual(["piren", "thor"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseCommaList("")).toEqual([]);
    expect(parseCommaList("   ")).toEqual([]);
  });
});
