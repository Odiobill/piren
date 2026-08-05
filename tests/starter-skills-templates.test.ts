import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  canonicalSkillDigest,
  createRealStarterSkillsDeps,
  parseSkillDocument,
  parseSkillFrontmatter,
  parseStarterManifest,
  validateProfileTemplates,
  validateStarterManifest,
} from "../src/starter-skills.js";

/**
 * Contract test for the shipped `templates/okf/` profile (S3a §1/§5).
 * Asserts the accepted S3 manifest identity/digest rules over the real
 * package template tree: type: Skill frontmatter, required name/description,
 * dir name == frontmatter name == manifest name, committed digest ==
 * canonical digest, and no secrets/absolute local paths/credentials.
 */

const repoRoot = process.cwd();
const templatesDir = join(repoRoot, "templates");
const deps = createRealStarterSkillsDeps();

const FORBIDDEN: Array<string | RegExp> = [
  "-----BEGIN",
  // OpenAI/Anthropic-style key prefixes: `sk-` + a long alphanumeric token
  // (16+ chars). A bare "sk-" substring is a false positive on legitimate
  // kebab names like "task-lifecycle".
  /sk-[a-z0-9]{16,}/i,
  "sk-proj-",
  "sk-ant-",
  "ghp_",
  "password:",
  "api_key:",
  "api-key:",
  "bearer ",
  "/mnt/",
  "/home/",
  "/Users/",
  "C:\\",
  "~/.pi/",
  "~/.config/",
];

describe("templates/okf manifest and templates (S3a contract)", () => {
  it("ships the okf manifest that parses and validates as shared-only", async () => {
    const manifestYaml = await readFile(join(templatesDir, "okf", "manifest.yml"), "utf8");
    const manifest = parseStarterManifest(manifestYaml);
    expect(() => validateStarterManifest(manifest)).not.toThrow();
    expect(manifest.profile).toBe("okf");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.entries.map((e) => e.name)).toEqual([
      "okf-authoring",
      "piren-vault-operations",
      "piren-knowledge-lifecycle",
    ]);
  });

  it("validates every template: type Skill, required fields, names agree, digest matches", async () => {
    const manifestYaml = await readFile(join(templatesDir, "okf", "manifest.yml"), "utf8");
    const manifest = parseStarterManifest(manifestYaml);
    const validation = await validateProfileTemplates(deps, templatesDir, manifest);
    expect(validation.templates).toHaveLength(3);
    for (const template of validation.templates) {
      const content = await deps.readFile(template.path);
      const doc = parseSkillDocument(content);
      expect(doc.name).toBe(template.entry.name);
      expect(doc.description).not.toBeNull();
      // The committed digest is the canonical digest of the parsed fields.
      expect(template.entry.content_sha256).toBe(canonicalSkillDigest(doc.name!, doc.description!, doc.body));
      // Every shipped template carries valid `type: Skill` frontmatter.
      const raw = parseSkillFrontmatter(content);
      expect(raw === null ? undefined : raw.type).toBe("Skill");
    }
  });

  it("contains no secrets, credentials, or absolute local paths", async () => {
    const manifestYaml = await readFile(join(templatesDir, "okf", "manifest.yml"), "utf8");
    const manifest = parseStarterManifest(manifestYaml);
    const texts: string[] = [manifestYaml];
    for (const entry of manifest.entries) {
      texts.push(await deps.readFile(join(templatesDir, "okf", entry.source)));
    }
    const lower = texts.join("\n").toLowerCase();
    for (const forbidden of FORBIDDEN) {
      if (typeof forbidden === "string") {
        expect(lower).not.toContain(forbidden.toLowerCase());
      } else {
        expect(lower).not.toMatch(forbidden);
      }
    }
  });
});

describe("templates/baseline manifest and template (S3 §12 contract)", () => {
  it("ships the baseline manifest that parses and validates as shared-only", async () => {
    const manifestYaml = await readFile(join(templatesDir, "baseline", "manifest.yml"), "utf8");
    const manifest = parseStarterManifest(manifestYaml);
    expect(() => validateStarterManifest(manifest)).not.toThrow();
    expect(manifest.profile).toBe("baseline");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.entries.map((e) => e.name)).toEqual(["piren-inbox-task-lifecycle"]);
  });

  it("validates the baseline template: type Skill, required fields, names agree, digest matches", async () => {
    const manifestYaml = await readFile(join(templatesDir, "baseline", "manifest.yml"), "utf8");
    const manifest = parseStarterManifest(manifestYaml);
    const validation = await validateProfileTemplates(deps, templatesDir, manifest);
    expect(validation.templates).toHaveLength(1);
    for (const template of validation.templates) {
      const content = await deps.readFile(template.path);
      const doc = parseSkillDocument(content);
      expect(doc.name).toBe(template.entry.name);
      expect(doc.name).toBe("piren-inbox-task-lifecycle");
      expect(doc.description).not.toBeNull();
      expect(template.entry.content_sha256).toBe(canonicalSkillDigest(doc.name!, doc.description!, doc.body));
      const raw = parseSkillFrontmatter(content);
      expect(raw === null ? undefined : raw.type).toBe("Skill");
    }
  });

  it("baseline template contains no secrets, credentials, or absolute local paths", async () => {
    const manifestYaml = await readFile(join(templatesDir, "baseline", "manifest.yml"), "utf8");
    const manifest = parseStarterManifest(manifestYaml);
    const texts: string[] = [manifestYaml];
    for (const entry of manifest.entries) {
      texts.push(await deps.readFile(join(templatesDir, "baseline", entry.source)));
    }
    const lower = texts.join("\n").toLowerCase();
    for (const forbidden of FORBIDDEN) {
      if (typeof forbidden === "string") {
        expect(lower).not.toContain(forbidden.toLowerCase());
      } else {
        expect(lower).not.toMatch(forbidden);
      }
    }
  });
});
