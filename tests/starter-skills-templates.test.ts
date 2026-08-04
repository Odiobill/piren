import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  canonicalSkillDigest,
  createRealStarterSkillsDeps,
  parseSkillDocument,
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

const FORBIDDEN = [
  "-----BEGIN",
  "sk-",
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
      expect(lower).not.toContain(forbidden.toLowerCase());
    }
  });
});
