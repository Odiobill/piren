import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPirenContext } from "../src/bootstrap.js";
import { initVault } from "../src/init.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-init-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Piren vault initialization", () => {
  it("creates a minimal vault fixture for one agent in any directory", async () => {
    const result = await initVault({ vaultRoot: root, agentName: "thor" });

    expect(result.vaultRoot).toBe(root);
    expect(result.agentDir).toBe(join(root, "team", "thor"));
    await expect(stat(join(root, ".piren-vault"))).resolves.toBeDefined();
    await expect(stat(join(root, "steward-directives.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "SOUL.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "MEMORY.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "config.yml"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "inbox"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "outbox"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "devices"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "logs"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "sessions"))).resolves.toBeDefined();
    await expect(stat(join(root, "agent-groups"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "groups"))).rejects.toThrow();
    await expect(stat(join(root, "Projects"))).resolves.toBeDefined();
    await expect(stat(join(root, "wiki", "concepts"))).resolves.toBeDefined();
    await expect(stat(join(root, "wiki", "entities"))).resolves.toBeDefined();

    const directives = await readFile(join(root, "steward-directives.md"), "utf8");
    expect(directives).toContain("Use OKF frontmatter with a non-empty type field");
    expect(directives).toContain("wiki_update_concept");
    expect(directives).toContain("Top-level directories use lowercase/kebab-case when Piren owns them");
    expect(directives).toContain("Projects/");
    const soul = await readFile(join(root, "team", "thor", "SOUL.md"), "utf8");
    expect(soul).toContain("When importing existing project material");
    expect(soul).toContain("wiki/concepts");

    const config = await readFile(join(root, "team", "thor", "config.yml"), "utf8");
    expect(config).not.toContain("allowed_agents:");
    expect(config).toContain("model:");
  });

  it("defaults the first agent to piren when no agent name is specified", async () => {
    const result = await initVault({ vaultRoot: root });

    expect(result.agentName).toBe("piren");
    expect(result.agentDir).toBe(join(root, "team", "piren"));
    await expect(stat(join(root, "team", "piren", "SOUL.md"))).resolves.toBeDefined();

    const config = await readFile(join(root, "team", "piren", "config.yml"), "utf8");
    expect(config).not.toContain("allowed_agents:");
    expect(config).toContain("model:");
  });

  it("creates a vault that can be immediately bootstrapped", async () => {
    const result = await initVault({ vaultRoot: root, agentName: "thor" });

    const context = await loadPirenContext({ cliAgentDir: result.agentDir, env: {}, configPath: join(root, "missing-config.yml") });

    expect(context.vaultRoot).toBe(root);
    expect(context.agentName).toBe("thor");
    expect(context.soul).toContain("# Thor");
    expect(context.stewardDirectives).toContain("# Steward Directives");
  });

  it("refuses to overwrite existing files unless force is enabled", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });

    await expect(initVault({ vaultRoot: root, agentName: "thor" })).rejects.toThrow(/already exists/i);
    await expect(initVault({ vaultRoot: root, agentName: "thor", force: true })).resolves.toBeDefined();
  });

  it("normalizes unsafe agent names", async () => {
    await expect(initVault({ vaultRoot: root, agentName: "../thor" })).rejects.toThrow(/agent name/i);
    await expect(initVault({ vaultRoot: root, agentName: "Thor Prime" })).rejects.toThrow(/agent name/i);
  });

  it("seeds the first two OKF starter graph documents", async () => {
    await initVault({ vaultRoot: root, agentName: "piren" });

    const entityPath = join(root, "wiki", "entities", "piren.md");
    const conceptPath = join(root, "wiki", "concepts", "open-knowledge-format.md");

    await expect(stat(entityPath)).resolves.toBeDefined();
    await expect(stat(conceptPath)).resolves.toBeDefined();

    const entity = await readFile(entityPath, "utf8");
    expect(entity).toContain("type: Entity");
    // links to the OKF concept so the starter graph is connected
    expect(entity).toContain("[[Open Knowledge Format]]");

    const concept = await readFile(conceptPath, "utf8");
    expect(concept).toContain("type: Concept");
    // links back to the Piren entity so the starter graph is connected
    expect(concept).toContain("wiki/entities/piren.md");

    // Structural frontmatter assertions: closed YAML block with created/updated
    for (const [label, doc] of [["Piren entity", entity], ["OKF concept", concept]] as const) {
      const lines = doc.split("\n");
      expect(lines[0], `${label}: frontmatter must open with ---`).toBe("---");
      const closeIndex = lines.indexOf("---", 1);
      expect(closeIndex, `${label}: frontmatter must have a closing ---`).toBeGreaterThan(0);
      const frontmatter = lines.slice(1, closeIndex).join("\n");
      expect(frontmatter, `${label}: frontmatter must contain created`).toContain("created:");
      expect(frontmatter, `${label}: frontmatter must contain updated`).toContain("updated:");
    }
  });

  it("seeds the piren-vault and piren-agent-operating-model concept docs", async () => {
    await initVault({ vaultRoot: root, agentName: "piren" });

    const vaultConceptPath = join(root, "wiki", "concepts", "piren-vault.md");
    const operatingModelPath = join(root, "wiki", "concepts", "piren-agent-operating-model.md");

    await expect(stat(vaultConceptPath)).resolves.toBeDefined();
    await expect(stat(operatingModelPath)).resolves.toBeDefined();

    const vaultConcept = await readFile(vaultConceptPath, "utf8");
    const operatingModel = await readFile(operatingModelPath, "utf8");

    const docs: Array<readonly [string, string]> = [
      ["piren-vault concept", vaultConcept],
      ["piren-agent-operating-model concept", operatingModel],
    ];

    for (const [label, doc] of docs) {
      const lines = doc.split("\n");
      expect(lines[0], `${label}: frontmatter must open with ---`).toBe("---");
      const closeIndex = lines.indexOf("---", 1);
      expect(closeIndex, `${label}: frontmatter must have a closing ---`).toBeGreaterThan(0);
      const frontmatter = lines.slice(1, closeIndex).join("\n");
      expect(frontmatter, `${label}: frontmatter must contain type: Concept`).toContain("type: Concept");
      expect(frontmatter, `${label}: frontmatter must contain created`).toContain("created:");
      expect(frontmatter, `${label}: frontmatter must contain updated`).toContain("updated:");
    }

    // Both docs must connect to the existing starter graph.
    expect(vaultConcept, "piren-vault must link to the Piren entity").toContain("wiki/entities/piren.md");
    expect(vaultConcept, "piren-vault must link to the OKF concept").toContain("[[Open Knowledge Format]]");
    expect(operatingModel, "operating model must link to the Piren entity").toContain("wiki/entities/piren.md");
    expect(operatingModel, "operating model must link to the piren-vault concept").toContain("[[Piren Vault]]");
  });

  it("seeds the knowledge-lifecycle and okf-knowledge-bundle concept docs", async () => {
    await initVault({ vaultRoot: root, agentName: "piren" });

    const knowledgeLifecyclePath = join(root, "wiki", "concepts", "knowledge-lifecycle.md");
    const okfBundlePath = join(root, "wiki", "concepts", "okf-knowledge-bundle.md");

    await expect(stat(knowledgeLifecyclePath)).resolves.toBeDefined();
    await expect(stat(okfBundlePath)).resolves.toBeDefined();

    const knowledgeLifecycle = await readFile(knowledgeLifecyclePath, "utf8");
    const okfBundle = await readFile(okfBundlePath, "utf8");

    const docs: Array<readonly [string, string]> = [
      ["knowledge-lifecycle concept", knowledgeLifecycle],
      ["okf-knowledge-bundle concept", okfBundle],
    ];

    for (const [label, doc] of docs) {
      const lines = doc.split("\n");
      expect(lines[0], `${label}: frontmatter must open with ---`).toBe("---");
      const closeIndex = lines.indexOf("---", 1);
      expect(closeIndex, `${label}: frontmatter must have a closing ---`).toBeGreaterThan(0);
      const frontmatter = lines.slice(1, closeIndex).join("\n");
      expect(frontmatter, `${label}: frontmatter must contain type: Concept`).toContain("type: Concept");
      expect(frontmatter, `${label}: frontmatter must contain created`).toContain("created:");
      expect(frontmatter, `${label}: frontmatter must contain updated`).toContain("updated:");
    }

    // Both docs must connect to the existing starter graph.
    expect(knowledgeLifecycle, "knowledge-lifecycle must link to the Piren entity").toContain("wiki/entities/piren.md");
    expect(knowledgeLifecycle, "knowledge-lifecycle must link to the piren-vault concept").toContain("[[Piren Vault]]");
    expect(okfBundle, "okf-knowledge-bundle must link to the OKF concept").toContain("[[Open Knowledge Format]]");
    expect(okfBundle, "okf-knowledge-bundle must link to the piren-vault concept").toContain("[[Piren Vault]]");
  });

  it("scaffolds the documented vault-protocol cron directories for shared and agent scopes", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });

    // Shared cron coordination directories.
    await expect(stat(join(root, "cron", "jobs"))).resolves.toBeDefined();
    await expect(stat(join(root, "cron", "runs"))).resolves.toBeDefined();

    // Agent-scoped cron coordination directories.
    await expect(stat(join(root, "team", "thor", "cron", "jobs"))).resolves.toBeDefined();
    await expect(stat(join(root, "team", "thor", "cron", "runs"))).resolves.toBeDefined();

    // Fresh scaffold cron directories must be empty: no jobs or runs are seeded.
    await expect(readdir(join(root, "cron", "jobs"))).resolves.toEqual([]);
    await expect(readdir(join(root, "cron", "runs"))).resolves.toEqual([]);
    await expect(readdir(join(root, "team", "thor", "cron", "jobs"))).resolves.toEqual([]);
    await expect(readdir(join(root, "team", "thor", "cron", "runs"))).resolves.toEqual([]);
  });

  it("seeds exactly the intended six starter graph markdown documents, no more and no less", async () => {
    await initVault({ vaultRoot: root, agentName: "piren" });

    const expected = [
      "wiki/entities/piren.md",
      "wiki/concepts/open-knowledge-format.md",
      "wiki/concepts/piren-vault.md",
      "wiki/concepts/piren-agent-operating-model.md",
      "wiki/concepts/knowledge-lifecycle.md",
      "wiki/concepts/okf-knowledge-bundle.md",
    ].sort();

    const entityDocs = (await readdir(join(root, "wiki", "entities")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `wiki/entities/${name}`);
    const conceptDocs = (await readdir(join(root, "wiki", "concepts")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `wiki/concepts/${name}`);
    const found = [...entityDocs, ...conceptDocs].sort();

    expect(found, "fresh init must seed exactly the six intended starter graph docs").toEqual(expected);
  });
});
