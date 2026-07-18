import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ADR-0033 D1: public documentation boundary.
 *
 * Repository-published documentation must be self-contained. It must not send a
 * public/developer reader to Piren-vault-only ADR or project files, and it must
 * not reference the historical vault location. The native vault
 * (`/mnt/nas/Piren`) owns ADRs and project planning; the repo ships only code,
 * `AGENTS.md`, and `docs/`.
 *
 * This static test scans the public repository documentation surface and fails
 * on:
 *   1. the historical vault path `/mnt/nas/Documents/vault/` anywhere;
 *   2. Markdown/HTML links whose target points to a vault-only ADR or the
 *      specific Piren project bundle (`decisions/ADR-*`, `Projects/Piren/`, or
 *      a GitHub URL into this repo's non-existent `Projects/` or `decisions/`);
 *   3. any Markdown link whose anchor text presents as an ADR reference
 *      (`ADR-<digits>`), because ADRs are vault-only and such a link either is
 *      broken or hides a missing target behind a generic URL;
 *   4. on the purely-public surface (everything except `AGENTS.md`), the
 *      literal vault-only paths `Projects/Piren/` and `decisions/ADR-` even
 *      when they appear as plain/backtick text (e.g. example link values);
 *   5. confirms the npm-packed documentation surface (`README.md` + `docs/`)
 *      is part of the audited set, so a packed artifact cannot reintroduce
 *      broken vault-only links.
 *
 * `AGENTS.md` is the one carved-out file: it legitimately references the ACTIVE
 * vault (`/mnt/nas/Piren/...`) as contributor/agent context (task point 3), so
 * checks 4 does not apply to it. Checks 1-3 still apply to it: it must not use
 * the historical path and must not contain broken Markdown/HTML ADR links.
 *
 * Generic documentation of a user's OWN vault layout stays allowed, e.g.
 * `Projects/<project>/decisions/` (a placeholder, not the literal Piren path).
 *
 * The test is formatting-tolerant and snapshot-free: it walks the real files
 * and applies regex checks, never comparing against frozen content.
 */

const root = process.cwd();
const HISTORICAL_VAULT = "/mnt/nas/Documents/vault/";

interface AuditFile {
  rel: string;
  content: string;
}

/** Recursively collect regular-file paths under `dir`. */
function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile()) acc.push(full);
  }
  return acc;
}

/** The audited public repository documentation surface. */
function collectAuditFiles(): AuditFile[] {
  const paths: string[] = [];
  for (const top of ["README.md", "CHANGELOG.md", "AGENTS.md"]) {
    paths.push(join(root, top));
  }
  for (const f of walk(join(root, "docs"))) if (f.endsWith(".md")) paths.push(f);
  for (const f of walk(join(root, "site"))) paths.push(f);

  const files: AuditFile[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    files.push({ rel: relative(root, p), content: readFileSync(p, "utf8") });
  }
  return files;
}

const AUDIT = collectAuditFiles();

/** Files that may legitimately reference the ACTIVE vault (point 3). */
function isActiveVaultContextFile(rel: string): boolean {
  return rel === "AGENTS.md";
}

describe("ADR-0033 D1: public documentation boundary", () => {
  it("audits a non-empty public documentation surface", () => {
    expect(AUDIT.length).toBeGreaterThan(0);
    const rels = AUDIT.map((f) => f.rel);
    // README and docs/ are the npm-packed docs surface; they must be audited.
    expect(rels).toContain("README.md");
    expect(rels.filter((r) => r.startsWith("docs/")).length).toBeGreaterThan(0);
  });

  describe("no historical vault path", () => {
    it("fails if any audited file references /mnt/nas/Documents/vault/", () => {
      const offenders = AUDIT.filter((f) => f.content.includes(HISTORICAL_VAULT)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  });

  describe("no vault-only ADR/project links", () => {
    /** Extract Markdown inline link (text,target) and HTML href targets. */
    function extractLinks(content: string): { text: string; target: string }[] {
      const links: { text: string; target: string }[] = [];
      const inline = /\[([^\]]*)\]\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = inline.exec(content)) !== null) {
        if (m[1] !== undefined && m[2] !== undefined) links.push({ text: m[1], target: m[2] });
      }
      const href = /href\s*=\s*"([^"]*)"/g;
      while ((m = href.exec(content)) !== null) {
        if (m[1] !== undefined) links.push({ text: "", target: m[1] });
      }
      return links;
    }

    function isVaultOnlyTarget(target: string): boolean {
      // Specific Piren project bundle path, or an ADR file link.
      if (/Projects\/Piren\//.test(target)) return true;
      if (/decisions\/ADR-/.test(target)) return true;
      // GitHub URL pointing into this repo's non-existent Projects/ or decisions/.
      if (/github\.com\/Odiobill\/piren\/[^)\s]*\/(Projects|decisions)\//.test(target)) return true;
      return false;
    }

    it("fails on any link target pointing to a vault-only ADR or the Piren project bundle", () => {
      const offenders: string[] = [];
      for (const f of AUDIT) {
        for (const { target } of extractLinks(f.content)) {
          if (isVaultOnlyTarget(target)) offenders.push(`${f.rel}: -> ${target}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("fails on any Markdown link whose anchor text presents as an ADR reference", () => {
      const offenders: string[] = [];
      for (const f of AUDIT) {
        for (const { text, target } of extractLinks(f.content)) {
          // ADRs are vault-only: an ADR-labelled link is broken or hides a
          // missing target behind a generic URL.
          if (/ADR-\d/.test(text)) offenders.push(`${f.rel}: [${text}](${target})`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("no literal vault-only paths on the purely-public surface", () => {
    it("fails if a non-AGENTS.md file contains 'Projects/Piren/' or 'decisions/ADR-' as text", () => {
      const offenders: string[] = [];
      for (const f of AUDIT) {
        if (isActiveVaultContextFile(f.rel)) continue; // AGENTS.md: active vault refs allowed
        if (/Projects\/Piren\//.test(f.content)) offenders.push(`${f.rel}: Projects/Piren/`);
        if (/decisions\/ADR-/.test(f.content)) offenders.push(`${f.rel}: decisions/ADR-`);
      }
      expect(offenders).toEqual([]);
    });

    it("still permits generic user-vault layout placeholders such as Projects/<project>/decisions/", () => {
      // Generic placeholders describe a user's own vault, not the Piren bundle.
      const genericExamples = [
        "Projects/<project>/decisions/",
        "Projects/<p>/decisions/",
      ];
      for (const sample of genericExamples) {
        expect(sample).toMatch(/Projects\/<[^>]+>\/decisions\//);
        expect(sample).not.toMatch(/Projects\/Piren\//);
      }
    });
  });

  describe("npm-packed documentation surface is audited", () => {
    it("declares docs/ in package.json files (packed surface)", () => {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        files?: string[];
      };
      expect(pkg.files ?? []).toContain("docs/");
    });

    it("includes README.md and the docs/ directory in the audit set", () => {
      const rels = AUDIT.map((f) => f.rel);
      expect(rels).toContain("README.md");
      // README.md is auto-packed by npm even though it is not in `files`.
      // docs/ is explicitly packed; every docs/*.md must be audited.
      const docsMd = rels.filter((r) => r.startsWith("docs/") && r.endsWith(".md"));
      expect(docsMd.length).toBeGreaterThan(0);
      const docsOnDisk = walk(join(root, "docs")).filter((f) => f.endsWith(".md")).length;
      expect(docsMd.length).toBe(docsOnDisk);
    });
  });
});
