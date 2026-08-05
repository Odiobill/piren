import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  BASELINE_DIRECTIVE_SECTION,
  BASELINE_PROFILE,
  BASELINE_SKILL_ID,
  BASELINE_SKILL_NAME,
  createBaselineSkill,
  loadBaselineAssets,
  probeRecognizedVault,
} from "../src/init-baseline.js";
import {
  canonicalSkillDigest,
  parseSkillDocument,
  parseStarterManifest,
  type StarterSkillsDeps,
} from "../src/starter-skills.js";

/**
 * Pure unit tests for the S3 §12 fresh-init baseline seam (recognition
 * probe, baseline asset loading, and no-clobber skill creation) over an
 * in-memory fake filesystem. No Pi auth, no real filesystem, no network.
 */

interface FakeFs {
  files: Map<string, string>;
  dirs: Set<string>;
  failRead: string[];
  failWrite: string[];
}

function fakeDeps(fs: FakeFs): StarterSkillsDeps {
  return {
    async readFile(path: string): Promise<string> {
      if (fs.failRead.some((prefix) => path.startsWith(prefix))) {
        const error = new Error(`EACCES: ${path}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      const content = fs.files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
    async writeFile(path: string, content: string, options?: { flag?: string }): Promise<void> {
      if (fs.failWrite.some((prefix) => path.startsWith(prefix))) {
        const error = new Error(`EACCES: ${path}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (options?.flag === "wx" && fs.files.has(path)) {
        const error = new Error(`EEXIST: ${path}`) as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      fs.files.set(path, content);
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      void options;
      fs.dirs.add(path);
    },
    async exists(path: string): Promise<boolean> {
      return fs.files.has(path) || fs.dirs.has(path);
    },
    async readdir(path: string): Promise<{ name: string; isDirectory(): boolean }[]> {
      if (fs.failRead.some((prefix) => path.startsWith(prefix))) {
        const error = new Error(`EACCES: ${path}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of fs.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment !== undefined && segment !== "") names.add(segment);
        }
      }
      for (const key of fs.dirs.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment !== undefined && segment !== "") names.add(segment);
        }
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => fs.dirs.has(`${prefix}${name}`) || fs.dirs.has(`${prefix}${name}/`),
      }));
    },
  };
}

function freshFs(): FakeFs {
  return { files: new Map(), dirs: new Set(), failRead: [], failWrite: [] };
}

/** Build a minimal valid baseline manifest + template in the fake fs. */
function seedBaselineAssets(fs: FakeFs, templatesDir: string): { content: string; digest: string } {
  const template = [
    "---",
    "type: Skill",
    "name: piren-inbox-task-lifecycle",
    'description: "Inbox task lifecycle procedure for tests."',
    "---",
    "",
    "# Inbox Task Lifecycle",
    "",
    "Procedure body.",
    "",
  ].join("\n");
  const doc = parseSkillDocument(template);
  const digest = canonicalSkillDigest(doc.name!, doc.description!, doc.body);
  fs.dirs.add(join(templatesDir, BASELINE_PROFILE));
  fs.files.set(
    join(templatesDir, BASELINE_PROFILE, "manifest.yml"),
    [
      "profile: baseline",
      "version: 1.0.0",
      "entries:",
      `  - id: ${BASELINE_SKILL_ID}`,
      `    name: ${BASELINE_SKILL_NAME}`,
      "    scope: shared",
      `    source: shared/${BASELINE_SKILL_NAME}/SKILL.md`,
      `    content_sha256: ${digest}`,
      "",
    ].join("\n"),
  );
  fs.dirs.add(join(templatesDir, BASELINE_PROFILE, "shared", BASELINE_SKILL_NAME));
  fs.files.set(join(templatesDir, BASELINE_PROFILE, "shared", BASELINE_SKILL_NAME, "SKILL.md"), template);
  return { content: template, digest };
}

const T = "/templates";
const V = "/vault";

describe("probeRecognizedVault (S3 §12.5)", () => {
  it("treats an empty target as a genuinely fresh vault", async () => {
    const fs = freshFs();
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(false);
  });

  it("recognizes a vault via the .piren-vault marker", async () => {
    const fs = freshFs();
    fs.files.set(join(V, ".piren-vault"), "");
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(true);
  });

  it("recognizes a vault via root steward-directives.md", async () => {
    const fs = freshFs();
    fs.files.set(join(V, "steward-directives.md"), "# Steward Directives\n");
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(true);
  });

  it("recognizes a vault via any team/<agent>/SOUL.md", async () => {
    const fs = freshFs();
    fs.dirs.add(join(V, "team"));
    fs.dirs.add(join(V, "team", "thor"));
    fs.files.set(join(V, "team", "thor", "SOUL.md"), "# Thor\n");
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(true);
  });

  it("does not recognize a team directory without any SOUL.md", async () => {
    const fs = freshFs();
    fs.dirs.add(join(V, "team"));
    fs.dirs.add(join(V, "team", "thor"));
    fs.files.set(join(V, "team", "thor", "MEMORY.md"), "# Memory\n");
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(false);
  });

  it("fails closed (recognized) on unreadable marker paths (EACCES)", async () => {
    const fs = freshFs();
    fs.failRead.push(join(V, ".piren-vault"));
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(true);
  });

  it("fails closed (recognized) on a non-ENOENT read error (no code)", async () => {
    const fs = freshFs();
    fs.failRead.push(join(V, "team"));
    await expect(probeRecognizedVault(fakeDeps(fs), V)).resolves.toBe(true);
  });
});

describe("loadBaselineAssets", () => {
  it("reports unavailable when the baseline manifest is missing", async () => {
    const fs = freshFs();
    const assets = await loadBaselineAssets(fakeDeps(fs), T);
    expect(assets.ok).toBe(false);
    if (!assets.ok) expect(assets.reason).toMatch(/unavailable/i);
  });

  it("reports invalid when the baseline manifest is malformed", async () => {
    const fs = freshFs();
    fs.files.set(join(T, BASELINE_PROFILE, "manifest.yml"), "not: [valid\n");
    const assets = await loadBaselineAssets(fakeDeps(fs), T);
    expect(assets.ok).toBe(false);
    if (!assets.ok) expect(assets.reason).toMatch(/invalid/i);
  });

  it("reports a profile mismatch fail-closed", async () => {
    const fs = freshFs();
    fs.files.set(
      join(T, BASELINE_PROFILE, "manifest.yml"),
      "profile: nope\nversion: 1.0.0\nentries: []\n",
    );
    const assets = await loadBaselineAssets(fakeDeps(fs), T);
    expect(assets.ok).toBe(false);
    if (!assets.ok) expect(assets.reason).toMatch(/profile mismatch/i);
  });

  it("loads and validates a valid baseline manifest + template", async () => {
    const fs = freshFs();
    seedBaselineAssets(fs, T);
    const assets = await loadBaselineAssets(fakeDeps(fs), T);
    expect(assets.ok).toBe(true);
    if (assets.ok) {
      expect(assets.manifest.profile).toBe(BASELINE_PROFILE);
      expect(assets.validation.templates).toHaveLength(1);
      expect(assets.validation.templates[0]?.entry.name).toBe(BASELINE_SKILL_NAME);
    }
  });
});

describe("createBaselineSkill", () => {
  async function loadedAssets(fs: FakeFs) {
    seedBaselineAssets(fs, T);
    const assets = await loadBaselineAssets(fakeDeps(fs), T);
    if (!assets.ok) throw new Error(`test setup: ${assets.reason}`);
    return assets;
  }

  it("creates the skill with the full manifest-derived provenance block", async () => {
    const fs = freshFs();
    const assets = await loadedAssets(fs);
    const result = await createBaselineSkill(fakeDeps(fs), V, assets);
    expect(result.created).toBe(true);
    expect(result.warning).toBeNull();

    const written = fs.files.get(join(V, "skills", BASELINE_SKILL_NAME, "SKILL.md"));
    expect(written).toBeDefined();
    expect(written).toContain(`id: ${BASELINE_SKILL_ID}`);
    expect(written).toContain(`profile: ${BASELINE_PROFILE}`);
    expect(written).toContain("version: 1.0.0");
    expect(written).toContain(`content_sha256: ${assets.manifest.entries[0]!.content_sha256}`);
    expect(written).toContain("# Inbox Task Lifecycle");
  });

  it("never overwrites an existing skill file (no-clobber, deterministic warning)", async () => {
    const fs = freshFs();
    const assets = await loadedAssets(fs);
    const target = join(V, "skills", BASELINE_SKILL_NAME, "SKILL.md");
    fs.dirs.add(join(V, "skills", BASELINE_SKILL_NAME));
    fs.files.set(target, "user-owned content\n");

    const result = await createBaselineSkill(fakeDeps(fs), V, assets);
    expect(result.created).toBe(false);
    expect(result.warning).toMatch(/already exists/i);
    expect(fs.files.get(target)).toBe("user-owned content\n");
  });

  it("surfaces a deterministic non-secret warning on an unexpected write failure", async () => {
    const fs = freshFs();
    const assets = await loadedAssets(fs);
    fs.failWrite.push(join(V, "skills"));
    const result = await createBaselineSkill(fakeDeps(fs), V, assets);
    expect(result.created).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toContain("EACCES");
    expect(fs.files.has(join(V, "skills", BASELINE_SKILL_NAME, "SKILL.md"))).toBe(false);
  });

  it("handles an empty baseline profile deterministically", async () => {
    const fs = freshFs();
    seedBaselineAssets(fs, T);
    fs.files.set(
      join(T, BASELINE_PROFILE, "manifest.yml"),
      "profile: baseline\nversion: 1.0.0\nentries: []\n",
    );
    const assets = await loadBaselineAssets(fakeDeps(fs), T);
    expect(assets.ok).toBe(true);
    if (assets.ok) {
      const result = await createBaselineSkill(fakeDeps(fs), V, assets);
      expect(result.created).toBe(false);
      expect(result.warning).toMatch(/no entries/i);
    }
  });
});

describe("BASELINE_DIRECTIVE_SECTION", () => {
  it("carries the mandatory non-negotiable rule wording", () => {
    expect(BASELINE_DIRECTIVE_SECTION).toContain("## Inbox task lifecycle (mandatory)");
    expect(BASELINE_DIRECTIVE_SECTION).toContain("Never poll an inbox automatically in a direct session");
    expect(BASELINE_DIRECTIVE_SECTION).toContain("claim it atomically");
    expect(BASELINE_DIRECTIVE_SECTION).toContain("skills/piren-inbox-task-lifecycle/SKILL.md");
    // Reference-check the exact manifest profile/id constants.
    expect(parseStarterManifest).toBeTypeOf("function");
    void BASELINE_SKILL_NAME;
  });
});
