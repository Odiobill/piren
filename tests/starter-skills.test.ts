import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  canonicalSkillDigest,
  parseSkillDocument,
  parseStarterManifest,
  validateStarterManifest,
} from "../src/starter-skills.js";

describe("canonicalSkillDigest (S3 §3)", () => {
  it("is a deterministic sha256 over fixed-order name/description/body", () => {
    const a = canonicalSkillDigest("okf-authoring", "Author OKF documents.", "# OKF\n\nBody.");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSkillDigest("okf-authoring", "Author OKF documents.", "# OKF\n\nBody.")).toBe(a);
  });

  it("changes when any of name, description, or body changes", () => {
    const base = canonicalSkillDigest("okf-authoring", "Author OKF documents.", "# OKF\n\nBody.");
    expect(canonicalSkillDigest("okf-authoring", "Author OKF documents.", "# OKF\n\nBody. changed")).not.toBe(base);
    expect(canonicalSkillDigest("okf-authoring", "Different description.", "# OKF\n\nBody.")).not.toBe(base);
    expect(canonicalSkillDigest("okf-authoring-x", "Author OKF documents.", "# OKF\n\nBody.")).not.toBe(base);
  });

  it("is stable across frontmatter field order (digest of parsed fields, not raw text)", () => {
    const orderA = parseSkillDocument(
      ["---", "name: okf-authoring", "description: Author OKF.", "type: Skill", "---", "", "# OKF"].join("\n"),
    );
    const orderB = parseSkillDocument(
      ["---", "type: Skill", "description: Author OKF.", "name: okf-authoring", "---", "", "# OKF"].join("\n"),
    );
    expect(orderA.name).toBe("okf-authoring");
    expect(orderB.name).toBe("okf-authoring");
    expect(canonicalSkillDigest(orderA.name!, orderA.description!, orderA.body)).toBe(
      canonicalSkillDigest(orderB.name!, orderB.description!, orderB.body),
    );
  });
});

describe("parseSkillDocument (S3 §3, loader-compatible)", () => {
  it("extracts name, description, and trimmed body from frontmatter", () => {
    const doc = parseSkillDocument(
      ["---", "name: okf-authoring", 'description: "Author OKF documents."', "type: Skill", "---", "", "# OKF", "", "Body."].join("\n"),
    );
    expect(doc.name).toBe("okf-authoring");
    expect(doc.description).toBe("Author OKF documents.");
    expect(doc.body).toBe("# OKF\n\nBody.");
  });

  it("returns null metadata and full body when there is no frontmatter", () => {
    const doc = parseSkillDocument("# No frontmatter\n\nBody.");
    expect(doc.name).toBeNull();
    expect(doc.description).toBeNull();
    expect(doc.body).toBe("# No frontmatter\n\nBody.");
  });

  it("tolerates malformed YAML frontmatter without throwing", () => {
    const doc = parseSkillDocument(["---", "name: [unclosed", "---", "", "# Body"].join("\n"));
    expect(doc.name).toBeNull();
    expect(doc.body).toBe("# Body");
  });
});

describe("parseStarterManifest (S3 §2)", () => {
  const validManifest = [
    "profile: okf",
    'version: "1.0.0"',
    "entries:",
    "  - id: okf-authoring",
    "    name: okf-authoring",
    "    scope: shared",
    "    source: shared/okf-authoring/SKILL.md",
    `    content_sha256: ${"a".repeat(64)}`,
  ].join("\n");

  it("parses a valid manifest", () => {
    const manifest = parseStarterManifest(validManifest);
    expect(manifest.profile).toBe("okf");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.entries).toEqual([
      {
        id: "okf-authoring",
        name: "okf-authoring",
        scope: "shared",
        source: "shared/okf-authoring/SKILL.md",
        content_sha256: "a".repeat(64),
      },
    ]);
  });

  it("rejects a manifest without a profile id", () => {
    const yaml = validManifest.replace("profile: okf\n", "");
    expect(() => parseStarterManifest(yaml)).toThrow(/profile/);
  });

  it("rejects a manifest with an invalid version", () => {
    const yaml = validManifest.replace('version: "1.0.0"', "version: not-a-version");
    expect(() => parseStarterManifest(yaml)).toThrow(/version/);
  });

  it("rejects an entry with a malformed digest", () => {
    const yaml = validManifest.replace("a".repeat(64), "short");
    expect(() => parseStarterManifest(yaml)).toThrow(/content_sha256/);
  });

  it("rejects an entry with a missing id", () => {
    const yaml = validManifest.replace("  - id: okf-authoring\n", "");
    expect(() => parseStarterManifest(yaml)).toThrow(/id/);
  });

  it("rejects duplicate entry ids and duplicate entry names", () => {
    const duplicateId = validManifest + "\n" + [
      "  - id: okf-authoring",
      "    name: other",
      "    scope: shared",
      "    source: shared/other/SKILL.md",
      `    content_sha256: ${"b".repeat(64)}`,
    ].join("\n");
    expect(() => parseStarterManifest(duplicateId)).toThrow(/duplicate/i);

    const duplicateName = validManifest + "\n" + [
      "  - id: other",
      "    name: okf-authoring",
      "    scope: shared",
      "    source: shared/other/SKILL.md",
      `    content_sha256: ${"b".repeat(64)}`,
    ].join("\n");
    expect(() => parseStarterManifest(duplicateName)).toThrow(/duplicate/i);
  });

  it("rejects an entry whose source escapes the profile tree", () => {
    const yaml = validManifest.replace("shared/okf-authoring/SKILL.md", "../escape/SKILL.md");
    expect(() => parseStarterManifest(yaml)).toThrow(/source/);
  });

  it("rejects an entry whose name is not lowercase kebab-case", () => {
    const yaml = validManifest.replace("name: okf-authoring", "name: NotValid Name");
    expect(() => parseStarterManifest(yaml)).toThrow(/name/);
  });
});

describe("validateStarterManifest (S3 §2/§3 fail-closed)", () => {
  const validManifest = [
    "profile: okf",
    'version: "1.0.0"',
    "entries:",
    "  - id: okf-authoring",
    "    name: okf-authoring",
    "    scope: shared",
    "    source: shared/okf-authoring/SKILL.md",
    `    content_sha256: ${"a".repeat(64)}`,
  ].join("\n");

  it("accepts a shared-scope-only manifest for the initial profile", () => {
    expect(() => validateStarterManifest(parseStarterManifest(validManifest))).not.toThrow();
  });

  it("rejects a non-shared scope in the initial profile (fail-closed)", () => {
    const yaml = validManifest.replace("scope: shared", "scope: group");
    expect(() => validateStarterManifest(parseStarterManifest(yaml))).toThrow(/scope/);
  });
});

// ---------------------------------------------------------------------------
// Tracer 2: doctor / plan / apply over an injected fake filesystem
// ---------------------------------------------------------------------------

import type { StarterSkillsDeps, StarterProfileManifest } from "../src/starter-skills.js";
import {
  applyStarterSeed,
  assertVaultRoot,
  buildSeededContent,
  classifyStarterEntry,
  planStarterSeed,
  runStarterDoctor,
  validateProfileTemplates,
} from "../src/starter-skills.js";

/** In-memory fake filesystem with files + implicit directories. */
function makeFakeDeps(): { deps: StarterSkillsDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const deps: StarterSkillsDeps = {
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFile: async (p, c, options) => {
      if (options?.flag === "wx" && files.has(p)) throw new Error(`EEXIST: ${p}`);
      files.set(p, c);
    },
    mkdir: async (p) => {
      dirs.add(p);
    },
    exists: async (p) => {
      if (files.has(p) || dirs.has(p)) return true;
      for (const key of files.keys()) if (key.startsWith(p + "/")) return true;
      for (const key of dirs) if (key.startsWith(p + "/")) return true;
      return false;
    },
    readdir: async (p) => {
      const names = new Set<string>();
      const isDir = new Map<string, boolean>();
      const scan = (key: string): void => {
        if (!key.startsWith(p + "/")) return;
        const rest = key.slice(p.length + 1);
        const first = rest.split("/")[0];
        if (first === undefined || first === "") return;
        names.add(first);
        const deeper = rest.indexOf("/") !== -1;
        isDir.set(first, (isDir.get(first) ?? false) || deeper || dirs.has(join(p, first)));
      };
      for (const key of files.keys()) scan(key);
      for (const key of dirs) scan(key);
      return [...names].map((name) => ({ name, isDirectory: () => isDir.get(name) ?? false }));
    },
  };
  return { deps, files };
}

function makeVault(): { vault: string } {
  return { vault: "/vault" };
}

function templateSkill(name: string, description: string, body: string): string {
  return ["---", `name: ${name}`, `description: "${description}"`, "type: Skill", "---", "", body].join("\n");
}

function makeManifest(entries: Array<{ id: string; name: string; description: string; body: string }>): StarterProfileManifest {
  return {
    profile: "okf",
    version: "1.0.0",
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      scope: "shared" as const,
      source: `shared/${e.name}/SKILL.md`,
      content_sha256: canonicalSkillDigest(e.name, e.description, e.body),
    })),
  };
}

function seedContent(entry: { id: string; name: string; description: string; body: string }, manifest: StarterProfileManifest): string {
  return buildSeededContent(templateSkill(entry.name, entry.description, entry.body), {
    id: entry.id,
    profile: manifest.profile,
    version: manifest.version,
    content_sha256: canonicalSkillDigest(entry.name, entry.description, entry.body),
  });
}

function writeTemplateTree(files: Map<string, string>, manifest: StarterProfileManifest, templates: Array<{ id: string; name: string; description: string; body: string }>): void {
  files.set("/templates/okf/manifest.yml", JSON.stringify(manifest));
  for (const t of templates) {
    files.set(`/templates/okf/shared/${t.name}/SKILL.md`, templateSkill(t.name, t.description, t.body));
  }
}

const ENTRY = { id: "okf-authoring", name: "okf-authoring", description: "Author OKF documents.", body: "# OKF\n\nAuthor compact OKF documents." };

describe("assertVaultRoot (S3 §7)", () => {
  it("rejects a missing vault root and a root without .piren-vault", async () => {
    const { deps } = makeFakeDeps();
    await expect(assertVaultRoot(deps, "/missing")).rejects.toThrow(/does not exist/);
    const { deps: deps2, files } = makeFakeDeps();
    files.set("/vault/steward-directives.md", "# directives");
    await expect(assertVaultRoot(deps2, "/vault")).rejects.toThrow(/not a Piren vault/);
  });

  it("accepts a vault root with the .piren-vault marker", async () => {
    const { deps, files } = makeFakeDeps();
    files.set("/vault/.piren-vault", "");
    await expect(assertVaultRoot(deps, "/vault")).resolves.toBeUndefined();
  });
});

describe("buildSeededContent (S3 §3 provenance injection)", () => {
  it("injects the full template block and preserves the template body", () => {
    const seeded = buildSeededContent(templateSkill("okf-authoring", "Author OKF.", "# Body\n\nSteps."), {
      id: "okf-authoring",
      profile: "okf",
      version: "1.0.0",
      content_sha256: "a".repeat(64),
    });
    expect(seeded).toContain("template:");
    expect(seeded).toContain("  id: okf-authoring");
    expect(seeded).toContain("  profile: okf");
    expect(seeded).toContain('  version: 1.0.0');
    expect(seeded).toContain(`  content_sha256: ${"a".repeat(64)}`);
    expect(seeded).toContain("# Body\n\nSteps.");
    expect(seeded).toContain("name: okf-authoring");
  });

  it("refuses to inject into content without a frontmatter fence", () => {
    expect(() => buildSeededContent("# No frontmatter", { id: "x", profile: "okf", version: "1.0.0", content_sha256: "a".repeat(64) })).toThrow(/frontmatter/);
  });
});

describe("validateProfileTemplates (S3 §2/§3)", () => {
  it("validates a consistent template tree and rejects digest drift", async () => {
    const manifest = makeManifest([ENTRY]);
    const { deps, files } = makeFakeDeps();
    writeTemplateTree(files, manifest, [ENTRY]);
    const result = await validateProfileTemplates(deps, "/templates", manifest);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.digest).toBe(manifest.entries[0]?.content_sha256);

    files.set("/templates/okf/shared/okf-authoring/SKILL.md", templateSkill(ENTRY.name, ENTRY.description, ENTRY.body + " changed"));
    await expect(validateProfileTemplates(deps, "/templates", manifest)).rejects.toThrow(/content_sha256/);
  });

  it("rejects a template missing frontmatter name or description", async () => {
    const manifest = makeManifest([ENTRY]);
    const { deps, files } = makeFakeDeps();
    writeTemplateTree(files, manifest, [ENTRY]);
    files.set("/templates/okf/shared/okf-authoring/SKILL.md", ["---", "type: Skill", "---", "", "body"].join("\n"));
    await expect(validateProfileTemplates(deps, "/templates", manifest)).rejects.toThrow(/name.*description/);
  });
});

describe("doctor classification (S3 §5 total, fail-closed)", () => {
  function vaultWithEntry(state: "absent" | "seeded-current" | "outdated" | "modified" | "invalid" | "identity-mismatch" | "digest-inconsistent") {
    const { deps, files } = makeFakeDeps();
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    files.set("/vault/skills/.keep", "");
    const manifest = makeManifest([ENTRY]);
    if (state !== "absent") {
      const target = "/vault/skills/okf-authoring/SKILL.md";
      if (state === "seeded-current") {
        files.set(target, seedContent(ENTRY, manifest));
      } else if (state === "outdated") {
        // Same content as the recorded digest, but manifest moved on.
        const digest = canonicalSkillDigest(ENTRY.name, ENTRY.description, ENTRY.body);
        files.set(target, buildSeededContent(templateSkill(ENTRY.name, ENTRY.description, ENTRY.body), {
          id: ENTRY.id,
          profile: "okf",
          version: "0.9.0",
          content_sha256: digest,
        }));
      } else if (state === "modified") {
        const seeded = seedContent(ENTRY, manifest);
        files.set(target, seeded.replace("# OKF", "# OKF (steward edited)"));
      } else if (state === "invalid") {
        files.set(target, templateSkill(ENTRY.name, ENTRY.description, ENTRY.body));
      } else if (state === "identity-mismatch") {
        files.set(target, buildSeededContent(templateSkill(ENTRY.name, ENTRY.description, ENTRY.body), {
          id: "other-id",
          profile: "okf",
          version: "1.0.0",
          content_sha256: manifest.entries[0]!.content_sha256,
        }));
      } else {
        // digest-inconsistent: current content, wrong recorded digest.
        files.set(target, buildSeededContent(templateSkill(ENTRY.name, ENTRY.description, ENTRY.body), {
          id: ENTRY.id,
          profile: "okf",
          version: "1.0.0",
          content_sha256: "b".repeat(64),
        }));
      }
    }
    return { deps, files, vault, manifest };
  }

  it("classifies a fresh vault file as absent (the only seedable state)", async () => {
    const { deps, vault, manifest } = vaultWithEntry("absent");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state.kind).toBe("absent");
    expect(result.duplicateOverlay).toBe(false);
  });

  it("classifies an exact seeded copy as seeded-current (full triple match)", async () => {
    const { deps, vault, manifest } = vaultWithEntry("seeded-current");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state).toEqual({ kind: "seeded-current", path: "/vault/skills/okf-authoring/SKILL.md" });
  });

  it("classifies an unmodified stale seed as seeded-outdated-unmodified", async () => {
    const { deps, vault, manifest } = vaultWithEntry("outdated");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state.kind).toBe("seeded-outdated-unmodified");
  });

  it("classifies a steward-edited copy as user-modified", async () => {
    const { deps, vault, manifest } = vaultWithEntry("modified");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state.kind).toBe("user-modified");
  });

  it("classifies a missing template block as provenance-invalid regardless of content", async () => {
    const { deps, vault, manifest } = vaultWithEntry("invalid");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state.kind).toBe("provenance-invalid");
  });

  it("classifies an identity mismatch as provenance-invalid regardless of digest", async () => {
    const { deps, vault, manifest } = vaultWithEntry("identity-mismatch");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state.kind).toBe("provenance-invalid");
    expect(result.state.kind === "provenance-invalid" ? result.state.reason : "").toMatch(/id.*mismatch/i);
  });

  it("classifies a digest-inconsistent copy as provenance-invalid even when content matches the manifest", async () => {
    const { deps, vault, manifest } = vaultWithEntry("digest-inconsistent");
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.state.kind).toBe("provenance-invalid");
    expect(result.state.kind === "provenance-invalid" ? result.state.reason : "").toMatch(/integrity-inconsistent/);
  });

  it("reports a blocking duplicate overlay when the name is active in another scope", async () => {
    const { deps, files, vault, manifest } = vaultWithEntry("absent");
    files.set(
      "/vault/agent-groups/developers/skills/okf-authoring/SKILL.md",
      templateSkill("okf-authoring", "Group variant.", "# Group\n"),
    );
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.duplicateOverlay).toBe(true);
    expect(result.state.kind).toBe("duplicate");
  });

  it("reports a blocking duplicate overlay for a loose shared file with the same name", async () => {
    const { deps, files, vault, manifest } = vaultWithEntry("absent");
    files.set("/vault/skills/okf-authoring.md", templateSkill("okf-authoring", "Loose shared.", "# Loose\n"));
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.duplicateOverlay).toBe(true);
    expect(result.state.kind).toBe("duplicate");
  });

  it("reports a blocking duplicate when the same template id is copied under another name", async () => {
    const { deps, files, vault, manifest } = vaultWithEntry("absent");
    files.set(
      "/vault/team/thor/skills/renamed/SKILL.md",
      buildSeededContent(templateSkill("renamed", "Copied template.", "# Renamed\n"), {
        id: ENTRY.id,
        profile: manifest.profile,
        version: manifest.version,
        content_sha256: manifest.entries[0]!.content_sha256,
      }),
    );
    const result = await classifyStarterEntry(deps, vault, manifest, manifest.entries[0]!);
    expect(result.duplicateOverlay).toBe(true);
    expect(result.state.kind).toBe("duplicate");
    expect(result.state.kind === "duplicate" ? result.state.reason : "").toMatch(/template id/i);
  });
});

describe("planStarterSeed (S3 §5 only absent is seedable)", () => {
  it("plans create for absent, unchanged for current, conflict otherwise; blocks on duplicate", async () => {
    const { deps, files } = makeFakeDeps();
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    const manifest = makeManifest([ENTRY]);
    const plan = await planStarterSeed(deps, vault, manifest);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.action).toBe("create");
    expect(plan.canApply).toBe(true);

    files.set("/vault/skills/okf-authoring/SKILL.md", seedContent(ENTRY, manifest));
    const planCurrent = await planStarterSeed(deps, vault, manifest);
    expect(planCurrent.items[0]?.action).toBe("unchanged");
    expect(planCurrent.canApply).toBe(false);

    files.set("/vault/skills/okf-authoring/SKILL.md", seedContent(ENTRY, manifest).replace("# OKF", "# OKF x"));
    const planModified = await planStarterSeed(deps, vault, manifest);
    expect(planModified.items[0]?.action).toBe("conflict");
    expect(planModified.canApply).toBe(false);

    files.set("/vault/team/thor/skills/okf-authoring/SKILL.md", templateSkill("okf-authoring", "Agent variant.", "# Agent\n"));
    const planDuplicate = await planStarterSeed(deps, vault, manifest);
    expect(planDuplicate.blockedByDuplicate).toBe(true);
    expect(planDuplicate.canApply).toBe(false);
  });
});

describe("applyStarterSeed (S3 §5)", () => {
  it("creates only absent files, injecting provenance that keeps the canonical digest", async () => {
    const { deps, files } = makeFakeDeps();
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    const manifest = makeManifest([ENTRY]);
    writeTemplateTree(files, manifest, [ENTRY]);

    const result = await applyStarterSeed(deps, "/templates", vault, manifest);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.path).toBe("/vault/skills/okf-authoring/SKILL.md");

    const seeded = files.get("/vault/skills/okf-authoring/SKILL.md");
    expect(seeded).toBeDefined();
    expect(seeded).toContain("template:");
    expect(seeded).toContain(`  id: ${ENTRY.id}`);
    expect(seeded).toContain("  profile: okf");
    // The seeded copy's canonical digest must equal the manifest digest (non-self-referential).
    const doc = parseSkillDocument(seeded!);
    expect(canonicalSkillDigest(doc.name!, doc.description!, doc.body)).toBe(manifest.entries[0]!.content_sha256);

    // A second apply is a no-op (unchanged), never overwrites.
    const second = await applyStarterSeed(deps, "/templates", vault, manifest);
    expect(second.created).toHaveLength(0);
    expect(files.get("/vault/skills/okf-authoring/SKILL.md")).toBe(seeded);
  });

  it("refuses entirely when a duplicate overlay blocks, writing nothing", async () => {
    const { deps, files } = makeFakeDeps();
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    const manifest = makeManifest([ENTRY]);
    writeTemplateTree(files, manifest, [ENTRY]);
    files.set("/vault/team/thor/skills/okf-authoring/SKILL.md", templateSkill("okf-authoring", "Agent.", "# Agent\n"));
    await expect(applyStarterSeed(deps, "/templates", vault, manifest)).rejects.toThrow(/duplicate/i);
    expect(files.has("/vault/skills/okf-authoring/SKILL.md")).toBe(false);
  });

  it("skips conflict files and never overwrites them", async () => {
    const { deps, files } = makeFakeDeps();
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    const manifest = makeManifest([ENTRY]);
    writeTemplateTree(files, manifest, [ENTRY]);
    files.set("/vault/skills/okf-authoring/SKILL.md", "# steward-owned content without provenance\n");
    const result = await applyStarterSeed(deps, "/templates", vault, manifest);
    expect(result.created).toHaveLength(0);
    expect(result.skippedConflicts).toHaveLength(1);
    expect(files.get("/vault/skills/okf-authoring/SKILL.md")).toBe("# steward-owned content without provenance\n");
  });

  it("uses exclusive creation when an absent target appears after planning", async () => {
    const base = makeFakeDeps();
    const { deps: baseDeps, files } = base;
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    const manifest = makeManifest([ENTRY]);
    writeTemplateTree(files, manifest, [ENTRY]);
    const deps: StarterSkillsDeps = {
      ...baseDeps,
      writeFile: async (path, content, options) => {
        if (path === "/vault/skills/okf-authoring/SKILL.md" && !(await baseDeps.exists(path))) {
          files.set(path, "race-owned content");
        }
        await baseDeps.writeFile(path, content, options);
      },
    };
    await expect(applyStarterSeed(deps, "/templates", vault, manifest)).rejects.toThrow(/EEXIST/);
    expect(files.get("/vault/skills/okf-authoring/SKILL.md")).toBe("race-owned content");
  });
});

describe("runStarterDoctor is read-only", () => {
  it("never writes anything, even on a populated vault", async () => {
    const { deps, files } = makeFakeDeps();
    const vault = "/vault";
    files.set("/vault/.piren-vault", "");
    const manifest = makeManifest([ENTRY]);
    files.set("/vault/skills/okf-authoring/SKILL.md", seedContent(ENTRY, manifest));
    const snapshot = new Map(files);
    await runStarterDoctor(deps, vault, manifest);
    expect(files).toEqual(snapshot);
  });
});
