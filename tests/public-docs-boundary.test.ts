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
 *      HTML `href` is matched in both single- and double-quoted form, and
 *      Markdown reference-style links (`[text][label]`, `[text][]`, shortcut
 *      `[label]`, plus `[label]: url` definitions) are resolved and checked;
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
 * check 4 does not apply to it. Checks 1-3 still apply to it: it must not use
 * the historical path and must not contain broken Markdown/HTML ADR links.
 *
 * Generic documentation of a user's OWN vault layout stays allowed, e.g.
 * `Projects/<project>/decisions/` (a placeholder, not the literal Piren path).
 *
 * The test is formatting-tolerant and snapshot-free: it walks the real files
 * and applies regex checks, never comparing against frozen content. The link
 * extractor is a module-scope helper so bypass-form regressions can exercise it
 * directly with fixture strings (forbidden literals live only in those
 * fixtures, never in the audited public docs).
 */

const root = process.cwd();
const HISTORICAL_VAULT = "/mnt/nas/Documents/vault/";

interface AuditFile {
  rel: string;
  content: string;
}

interface Link {
  text: string;
  target: string;
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

/** Normalize a Markdown reference label (case-insensitive, collapsed spaces). */
function normalizeRefLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Extract link (text, target) pairs from Markdown or HTML so the boundary
 * checks are formatting-tolerant. Recognizes:
 *   - inline Markdown `[text](target)`;
 *   - HTML `href='...'` and `href="..."` (matching quotes via backreference);
 *   - Markdown reference definitions `[label]: <target>` (the definition target
 *     is surfaced as a link too, so a vault-only def is caught even if unused);
 *   - reference-style usages `[text][label]` and collapsed `[text][]`, resolved
 *     through the definition map;
 *   - shortcut references `[label]` when a matching definition exists.
 */
function extractLinks(content: string): Link[] {
  const links: Link[] = [];
  let m: RegExpExecArray | null;

  // 1. Inline Markdown: [text](target)
  const inline = /\[([^\]]*)\]\(([^)]*)\)/g;
  while ((m = inline.exec(content)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) links.push({ text: m[1], target: m[2] });
  }

  // 2. HTML href, single- or double-quoted (backreference matches the same quote).
  const href = /href\s*=\s*(["'])(.*?)\1/g;
  while ((m = href.exec(content)) !== null) {
    if (m[2] !== undefined) links.push({ text: "", target: m[2] });
  }

  // 3. Markdown reference definitions: [label]: <target> ["title"]
  const defs = new Map<string, string>();
  const defRe = /^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+"[^"]*")?/gm;
  while ((m = defRe.exec(content)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      const label = m[1];
      const target = m[2];
      defs.set(normalizeRefLabel(label), target);
      links.push({ text: label, target }); // def with a vault-only target is itself a violation
    }
  }

  // 4. Reference-style usages: [text][label] and collapsed [text][]
  const refFull = /\[([^\]]+)\]\[([^\]]*)\]/g;
  while ((m = refFull.exec(content)) !== null) {
    const text = m[1] ?? "";
    const labelRaw = m[2] ?? "";
    const key = normalizeRefLabel(labelRaw !== "" ? labelRaw : text);
    links.push({ text, target: defs.get(key) ?? "" });
  }

  // 5. Shortcut references: [label] only when a definition resolves, and not
  //    part of an inline link (`](`) or a full reference (`][`).
  const shortcut = /\[([^\]]+)\](?!\(|\[)/g;
  while ((m = shortcut.exec(content)) !== null) {
    const label = m[1] ?? "";
    const target = defs.get(normalizeRefLabel(label));
    if (target !== undefined) links.push({ text: label, target });
  }

  return links;
}

/** True if a link target points to a vault-only ADR or the Piren project bundle. */
function isVaultOnlyTarget(target: string): boolean {
  // Specific Piren project bundle path, or an ADR file link.
  if (/Projects\/Piren\//.test(target)) return true;
  if (/decisions\/ADR-/.test(target)) return true;
  // GitHub URL pointing into this repo's non-existent Projects/ or decisions/.
  if (/github\.com\/Odiobill\/piren\/[^)\s]*\/(Projects|decisions)\//.test(target)) return true;
  return false;
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

// ---------------------------------------------------------------------------
// Link extractor regression: bypass forms that the D1 acceptance requires the
// formatting-tolerant scanner to catch. These exercise the module-scope helper
// directly with fixture strings. Forbidden target literals live ONLY in these
// fixtures; they are never placed in the audited public docs.
// ---------------------------------------------------------------------------

describe("link extractor: bypass-form regression (ADR-0033 D1)", () => {
  /** Mirror the audit's two offender predicates for a fixture string. */
  function vaultOnlyTargets(fixture: string): string[] {
    return extractLinks(fixture)
      .filter((l) => isVaultOnlyTarget(l.target))
      .map((l) => l.target);
  }
  function adrLabelledLinks(fixture: string): string[] {
    return extractLinks(fixture)
      .filter((l) => /ADR-\d/.test(l.text))
      .map((l) => `[${l.text}]`);
  }

  describe("HTML href quoting", () => {
    it("catches a single-quoted href into decisions/", () => {
      const fixture = `<a href='https://github.com/Odiobill/piren/tree/main/decisions/ADR-9999-x.md'>x</a>`;
      expect(vaultOnlyTargets(fixture).length).toBeGreaterThan(0);
    });

    it("catches a double-quoted href into decisions/", () => {
      const fixture = `<a href="https://github.com/Odiobill/piren/tree/main/decisions/ADR-9999-x.md">x</a>`;
      expect(vaultOnlyTargets(fixture).length).toBeGreaterThan(0);
    });

    it("catches a single-quoted href into Projects/Piren/", () => {
      const fixture = `<a href='/Projects/Piren/architecture.md'>x</a>`;
      expect(vaultOnlyTargets(fixture).length).toBeGreaterThan(0);
    });

    it("does not flag a benign single-quoted href", () => {
      const fixture = `<a href='https://example.com/'>x</a>`;
      expect(vaultOnlyTargets(fixture)).toEqual([]);
    });
  });

  describe("Markdown reference-style links", () => {
    it("catches an ADR-labelled reference link with a vault-only definition target", () => {
      const fixture = `See [ADR-9999][decision].\n\n[decision]: ../decisions/ADR-9999-example.md`;
      // Both the ADR-labelled anchor text AND the resolved vault-only target trip.
      expect(adrLabelledLinks(fixture)).toContain("[ADR-9999]");
      expect(vaultOnlyTargets(fixture)).toContain("../decisions/ADR-9999-example.md");
    });

    it("catches a collapsed reference link [text][] resolving to a vault-only target", () => {
      const fixture = `See [vault-thing][].\n\n[vault-thing]: /Projects/Piren/secret.md`;
      expect(vaultOnlyTargets(fixture)).toContain("/Projects/Piren/secret.md");
    });

    it("catches a bare reference definition with a vault-only target (even if unused)", () => {
      const fixture = `[unused]: /Projects/Piren/decisions/ADR-0001-x.md`;
      expect(vaultOnlyTargets(fixture).length).toBeGreaterThan(0);
    });

    it("catches an ADR-labelled reference link even when the target itself is benign", () => {
      // Proves reference-usage extraction matters: the text is the violation.
      const fixture = `See [ADR-9999][ok].\n\n[ok]: https://example.com/`;
      expect(adrLabelledLinks(fixture)).toContain("[ADR-9999]");
      expect(vaultOnlyTargets(fixture)).toEqual([]);
    });

    it("catches a shortcut reference link to a vault-only target", () => {
      const fixture = `See [note] for details.\n\n[note]: /Projects/Piren/plan.md`;
      expect(vaultOnlyTargets(fixture)).toContain("/Projects/Piren/plan.md");
    });

    it("does not flag benign reference links or GitHub release-tag definitions", () => {
      const fixture = `Released as [0.1.0].\n\n[0.1.0]: https://github.com/Odiobill/piren/releases/tag/v0.1.0`;
      expect(vaultOnlyTargets(fixture)).toEqual([]);
      expect(adrLabelledLinks(fixture)).toEqual([]);
    });
  });

  describe("inline Markdown (unchanged behaviour)", () => {
    it("still catches an inline link to ../decisions/ADR-*", () => {
      const fixture = `[ADR-0002](../decisions/ADR-0002-vault-as-source-of-truth.md)`;
      expect(vaultOnlyTargets(fixture).length).toBeGreaterThan(0);
      expect(adrLabelledLinks(fixture)).toContain("[ADR-0002]");
    });

    it("does not flag a benign inline link", () => {
      const fixture = `[scheduler](scheduler.md)`;
      expect(vaultOnlyTargets(fixture)).toEqual([]);
      expect(adrLabelledLinks(fixture)).toEqual([]);
    });
  });
});
