import { describe, expect, it } from "vitest";
import {
  checkOkfConceptDocument,
  parseOkfFrontmatter,
  PIREN_OKF_TYPES,
  isOkfReservedFilename,
  isOkfSystemFilename,
  isOkfConceptFilename,
  isClaimedFilename,
  checkVaultConformance,
  formatVaultConformanceReport,
  type VaultDirReader,
} from "../src/okf.js";

/** Build an in-memory vault from a { relativePath: content } map. */
function fakeReader(files: Record<string, string>): VaultDirReader {
  const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
  return {
    async list(path: string) {
      const seen = new Set<string>();
      const out: { name: string; isDirectory: boolean }[] = [];
      for (const { path: filePath } of entries) {
        let rel: string | null;
        if (path === "") {
          rel = filePath;
        } else if (filePath === path) {
          continue;
        } else if (filePath.startsWith(path + "/")) {
          rel = filePath.slice(path.length + 1);
        } else {
          continue;
        }
        const segment = rel.split("/")[0]!;
        if (seen.has(segment)) continue;
        seen.add(segment);
        out.push({ name: segment, isDirectory: rel.includes("/") });
      }
      return out;
    },
    async readFile(path: string) {
      const entry = entries.find((e) => e.path === path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      return entry.content;
    },
  };
}

describe("parseOkfFrontmatter", () => {
  it("parses a frontmatter block into fields and body", () => {
    const src = "---\ntype: Concept\ntitle: Foo\n---\n\n# Foo\n\nBody.\n";
    const parsed = parseOkfFrontmatter(src);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.terminated).toBe(true);
    expect(parsed.fields["type"]).toBe("Concept");
    expect(parsed.body.trim()).toBe("# Foo\n\nBody.");
  });

  it("treats content without frontmatter as body only", () => {
    const parsed = parseOkfFrontmatter("# Hello\n\nNo frontmatter.\n");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toContain("Hello");
  });

  it("flags an unterminated frontmatter block", () => {
    const src = "---\ntype: Concept\nstill open\n";
    const parsed = parseOkfFrontmatter(src);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.terminated).toBe(false);
  });
});

describe("checkOkfConceptDocument", () => {
  it("is conformant when frontmatter has a non-empty type", () => {
    const src = "---\ntype: Concept\ntitle: Foo\n---\n\n# Foo\n\nBody.\n";
    const result = checkOkfConceptDocument("wiki/concepts/foo.md", src);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("reports missing frontmatter when a concept has none", () => {
    const src = "# Just a heading\n\nNo frontmatter at all.\n";
    const result = checkOkfConceptDocument("wiki/concepts/foo.md", src);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: "missing-frontmatter" }),
    ]);
  });

  it("reports missing type when frontmatter has no type field", () => {
    const src = "---\ntitle: Foo\ntags: [a]\n---\n\n# Foo\n";
    const result = checkOkfConceptDocument("wiki/concepts/foo.md", src);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: "missing-type" }),
    ]);
  });

  it("reports missing type when type is null or empty", () => {
    const nullSrc = "---\ntype:\ntitle: Foo\n---\n\n# Foo\n";
    const emptySrc = '---\ntype: ""\ntitle: Foo\n---\n\n# Foo\n';
    expect(checkOkfConceptDocument("a.md", nullSrc).problems[0]?.kind).toBe("missing-type");
    expect(checkOkfConceptDocument("a.md", emptySrc).problems[0]?.kind).toBe("missing-type");
  });

  it("reports unterminated frontmatter", () => {
    const src = "---\ntype: Concept\nno close\n";
    const result = checkOkfConceptDocument("wiki/concepts/foo.md", src);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: "unterminated-frontmatter" }),
    ]);
  });

  it("tolerates an unknown type value instead of rejecting it", () => {
    const src = "---\ntype: Something New\ntitle: Foo\n---\n\n# Foo\n";
    const result = checkOkfConceptDocument("wiki/concepts/foo.md", src);
    expect(result.ok).toBe(true);
  });

  it("reports missing type when type is a non-string scalar", () => {
    const src = "---\ntype: 42\ntitle: Foo\n---\n\n# Foo\n";
    const result = checkOkfConceptDocument("a.md", src);
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.kind).toBe("missing-type");
  });
});

describe("OKF filename predicates", () => {
  it("recognizes OKF reserved filenames", () => {
    expect(isOkfReservedFilename("index.md")).toBe(true);
    expect(isOkfReservedFilename("log.md")).toBe(true);
    expect(isOkfReservedFilename("foo.md")).toBe(false);
  });

  it("recognizes Piren system filenames excluded from conformance", () => {
    expect(isOkfSystemFilename("SOUL.md")).toBe(true);
    expect(isOkfSystemFilename("MEMORY.md")).toBe(true);
    expect(isOkfSystemFilename("steward-directives.md")).toBe(true);
    expect(isOkfSystemFilename("AGENTS.md")).toBe(true);
    expect(isOkfSystemFilename("README.md")).toBe(true);
    expect(isOkfSystemFilename("foo.md")).toBe(false);
  });

  it("exposes the documented Piren type taxonomy without rejecting unknowns", () => {
    expect(PIREN_OKF_TYPES).toContain("Concept");
    expect(PIREN_OKF_TYPES).toContain("Cron Run");
    expect(Array.isArray(PIREN_OKF_TYPES)).toBe(true);
  });

  it("recognizes concept filenames and excludes reserved/system/claim files", () => {
    expect(isOkfConceptFilename("foo.md")).toBe(true);
    expect(isOkfConceptFilename("index.md")).toBe(false);
    expect(isOkfConceptFilename("log.md")).toBe(false);
    expect(isOkfConceptFilename("SOUL.md")).toBe(false);
    expect(isOkfConceptFilename("MEMORY.md")).toBe(false);
    expect(isOkfConceptFilename("steward-directives.md")).toBe(false);
    expect(isOkfConceptFilename("AGENTS.md")).toBe(false);
    expect(isOkfConceptFilename("README.md")).toBe(false);
    expect(isOkfConceptFilename("notes.txt")).toBe(false);
  });

  it("detects transient claimed files so they are skipped during a walk", () => {
    expect(isClaimedFilename("task-1.claimed.heimdall.md")).toBe(true);
    expect(isClaimedFilename("job.claimed.pi-4.md")).toBe(true);
    expect(isClaimedFilename("task-1.md")).toBe(false);
  });
});

describe("checkVaultConformance", () => {
  it("is conformant for a vault where every concept doc has a type", async () => {
    const reader = fakeReader({
      "wiki/concepts/fleet-profiles.md": "---\ntype: Concept\ntitle: Fleet Profiles\n---\n\nbody\n",
      "wiki/entities/pi.md": "---\ntype: Entity\ntitle: Pi\n---\n\nbody\n",
      "index.md": "# Index\n",
      "wiki/concepts/index.md": "# Concepts Index\n",
      "team/piren/SOUL.md": "# Piren\n",
    });
    const result = await checkVaultConformance({ root: "", reader });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.problems).toEqual([]);
  });

  it("reports concept docs missing frontmatter or type as problems", async () => {
    const reader = fakeReader({
      "wiki/concepts/good.md": "---\ntype: Concept\n---\n\n# Good\n",
      "wiki/concepts/no-type.md": "---\ntitle: No Type\n---\n\n# No Type\n",
      "wiki/concepts/no-fm.md": "# Just heading\n",
    });
    const result = await checkVaultConformance({ root: "", reader });
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(3);
    expect(result.problems).toHaveLength(2);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "wiki/concepts/no-type.md", kind: "missing-type" }),
        expect.objectContaining({ path: "wiki/concepts/no-fm.md", kind: "missing-frontmatter" }),
      ]),
    );
  });

  it("skips reserved filenames, system filenames, non-markdown files, dotfiles, and claim files", async () => {
    const reader = fakeReader({
      "index.md": "# Root index\n",
      "Projects/Piren/index.md": "---\ntype: Project Index\n---\n# Piren\n",
      "Projects/Piren/log.md": "# Log\n## 2026-06-28\n- entry\n",
      "team/piren/SOUL.md": "# Piren\n",
      "team/piren/MEMORY.md": "# Memory\n",
      "team/piren/steward-directives.md": "# Directives\n",
      "steward-directives.md": "# Root directives\n",
      "AGENTS.md": "# Agents\n",
      "wiki/raw/notes.md": "---\ntype: Concept\n---\n# Notes\n",
      "team/piren/inbox/task-1.claimed.heimdall.md": "---\ntype: Task\n---\n# Task\n",
      ".git/config": "stuff",
      "README.md": "# Read me",
    });
    const result = await checkVaultConformance({ root: "", reader });
    // Only wiki/raw/notes.md is a concept subject to checks here; everything else is skipped.
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("skips directories explicitly excluded from OKF scope", async () => {
    const reader = fakeReader({
      "wiki/concepts/ok.md": "---\ntype: Concept\n---\n# Ok\n",
      "node_modules/pkg/README.md": "# pkg\n",
      ".git/refs.md": "---\ntype: Concept\n---\n# Refs\n",
    });
    const result = await checkVaultConformance({ root: "", reader, exclude: ["node_modules", ".git"] });
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("caps the number of checked files to avoid pathological walks", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`wiki/concepts/c${i}.md`] = "---\ntype: Concept\n---\n# C\n";
    }
    const reader = fakeReader(files);
    const result = await checkVaultConformance({ root: "", reader, maxFiles: 3 });
    expect(result.checked).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("treats an unreadable file as a problem rather than crashing the walk", async () => {
    const reader: VaultDirReader = {
      async list(path: string) {
        if (path === "") return [{ name: "wiki", isDirectory: true }];
        if (path === "wiki") return [{ name: "concepts", isDirectory: true }];
        if (path === "wiki/concepts") return [{ name: "boom.md", isDirectory: false }];
        return [];
      },
      async readFile() {
        throw new Error("ENOENT");
      },
    };
    const result = await checkVaultConformance({ root: "", reader });
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.kind).toBe("unreadable");
  });
});

describe("formatVaultConformanceReport", () => {
  it("summarizes a conformant vault", () => {
    const text = formatVaultConformanceReport({
      root: "vault",
      ok: true,
      checked: 3,
      truncated: false,
      problems: [],
    });
    expect(text).toContain("conformant");
    expect(text).toContain("checked 3");
  });

  it("lists problems for a non-conformant vault", () => {
    const text = formatVaultConformanceReport({
      root: "vault",
      ok: false,
      checked: 2,
      truncated: false,
      problems: [
        { path: "wiki/concepts/x.md", kind: "missing-type" },
        { path: "wiki/concepts/y.md", kind: "missing-frontmatter" },
      ],
    });
    expect(text).toContain("NOT conformant");
    expect(text).toContain("2 problem");
    expect(text).toContain("missing-type");
    expect(text).toContain("missing-frontmatter");
  });
});
