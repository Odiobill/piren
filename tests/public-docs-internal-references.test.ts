import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * T7: packaged documentation boundary regression.
 *
 * README.md, docs/**\/*.md, and the fresh-vault starter-skill templates
 * (templates/** -> dist/templates/** via scripts/copy-templates.ts) must serve
 * Piren users and their agents only. This narrow, deterministic test pins the
 * specific forbidden internal references identified by the T7 audit inventory:
 *
 *   - internal slice/tracer-bullet labels (C1, C3-A, C4-A, C5, U2-U5, P1-P5,
 *     R2, R3, TB4-TB8);
 *   - internal agent/steward/device names (Nora, sam, nora, thor, ironman,
 *     heimdall, codex, dipu, zai, dario);
 *   - internal vault paths (/mnt/nas, /home/davide);
 *   - repository-internal source/test/dist/web paths and build commands
 *     (src/, tests/, dist/, web/, npm run build/test/typecheck/smoke,
 *     clean-install:check, npm pack, prepack, tsc, Vitest, esbuild);
 *   - contributor/package workflows (github:Odiobill/piren, --install-links,
 *     exactOptionalPropertyTypes, noUncheckedIndexedAccess, source checkout,
 *     from source, Acceptance checklist, Verify the repository, smoke tests,
 *     fake Pi harness, phase-specific);
 *   - Piren's own development-process wording (coding-agent instructions,
 *     stable implementation rules, the project handoff, "AGENTS.md in the
 *     repo").
 *
 * Deliberately narrow: only the exact audit literals are checked. Legitimate
 * user-facing vocabulary such as "source of truth", "npm install -g
 * @odiobill/piren", "CI", "GitHub", "testing", or a bare "AGENTS.md"
 * vault-protocol fact ("do not put AGENTS.md under team/<agent>/") is never
 * blacklisted.
 *
 * The test also verifies the built packaged template output (dist/templates)
 * is byte-for-byte aligned with the source templates, so a source edit can
 * never ship stale or divergent template content.
 */

const root = process.cwd();

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

interface Surface {
  rel: string;
  content: string;
}

function collectSurfaces(): Surface[] {
  const paths: string[] = ["README.md", "site/index.html"];
  for (const f of walk(join(root, "docs"))) if (f.endsWith(".md")) paths.push(f);
  for (const f of walk(join(root, "templates"))) {
    if (f.endsWith(".md") || f.endsWith(".yml")) paths.push(f);
  }
  return paths
    .filter((p) => existsSync(p))
    .map((p) => ({ rel: relative(root, p), content: readFileSync(p, "utf8") }));
}

const SURFACES = collectSurfaces();

/**
 * Hide HTML image/asset src attributes (e.g. the README logo
 * `src="web/src/assets/piren-logo.png"`) before repository-internal-path
 * checks: those point at repository assets for README rendering and are not
 * internal-reference prose.
 */
function maskAssetSrcs(content: string): string {
  return content.replace(/src\s*=\s*["'][^"']*["']/g, 'src="..."');
}

/** (group label, regex, justification). Patterns intentionally exclude the `g` flag; matching adds it. */
const FORBIDDEN: Array<{ group: string; pattern: RegExp; note: string }> = [
  {
    group: "internal slice/tracer-bullet labels",
    pattern: /\b(?:C1|C3-A|C4-A|C5|U2|U3|U4|U5|P1|P2|P3|P4|P5|R2|R3|TB4|TB5|TB6|TB7|TB8)\b/,
    note: "T7 Class I: internal tracer/slice labels must not appear in shipped docs",
  },
  {
    group: "internal agent/steward/device names",
    // Case-insensitive: internal names must be absent in any casing (e.g.
    // "Ironman", "Nora", "Sam"), not just the exact audit spellings.
    pattern: /\b(?:Nora|sam|thor|ironman|heimdall|codex|dipu|zai|dario)\b/i,
    note: "T7 Class II: internal agent/steward/device names must be replaced by neutral examples",
  },
  {
    group: "internal vault paths",
    pattern: /\/mnt\/nas|\/home\/davide/,
    note: "T7 Class II/III: internal vault/install paths must not appear",
  },
  {
    group: "repository-internal source/test/dist/web paths",
    pattern: /\b(?:src|tests|dist|web)\//,
    note: "T7 Class V: repository-internal paths (src/, tests/, dist/, web/) must not appear (image src attributes are masked)",
  },
  {
    group: "build/test/verification commands",
    pattern: /\b(?:npm run build|npm test|npm run typecheck|npm run smoke|npm run clean-install:check|npm pack|prepack|tsc|Vitest|esbuild)\b/,
    note: "T7 Class V: contributor build/test commands must not appear",
  },
  {
    group: "contributor/package install workflows",
    pattern: /github:Odiobill\/piren|--install-links/,
    note: "T7 Class V: GitHub/--install-links contributor installs must not appear",
  },
  {
    group: "contributor verification terminology",
    pattern: /\b(?:exactOptionalPropertyTypes|noUncheckedIndexedAccess|source checkout|source checkouts|Acceptance checklist|Verify the repository|smoke test|smoke tests|fake Pi harness|fake harness|phase-specific)\b/,
    note: "T7 Class III/V: contributor verification terminology must not appear",
  },
  {
    group: "development-process wording",
    pattern: /coding-agent instructions|stable implementation rules|AGENTS\.md in the repo|Piren vault project handoff|from source/,
    note: "T7 Class V: Piren's own development process must not be documented for users",
  },
  {
    group: "residual CI wording",
    // Pins the exact residual phrase from Lead verification ("For disposable
    // vaults or CI"); a narrow phrase pin, not a general ban on the word CI.
    pattern: /\bor CI\b/i,
    note: "T7 finding 66: 'or CI' must not reappear as motivation wording in user docs",
  },
];

function findingsFor(content: string): string[] {
  const findings: string[] = [];
  for (const { group, pattern } of FORBIDDEN) {
    const probe = group === "repository-internal source/test/dist/web paths" ? maskAssetSrcs(content) : content;
    for (const match of probe.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) {
      findings.push(`[${group}] ${match[0]}`);
    }
  }
  return findings;
}

describe("T7 packaged documentation boundary (internal references)", () => {
  it("audits README.md, docs/, and templates/ surfaces", () => {
    expect(SURFACES.length).toBeGreaterThan(0);
    const rels = SURFACES.map((s) => s.rel);
    expect(rels).toContain("README.md");
    expect(rels.some((r) => r.startsWith("docs/"))).toBe(true);
    expect(rels.some((r) => r.startsWith("templates/"))).toBe(true);
  });

  it("contains no forbidden internal references in any audited surface", () => {
    const findings: string[] = [];
    for (const s of SURFACES) {
      for (const finding of findingsFor(s.content)) {
        findings.push(`${s.rel}: ${finding}`);
      }
    }
    expect(findings).toEqual([]);
  });

  describe("packaged starter-skill template output (dist/templates)", () => {
    it("is byte-for-byte aligned with the source templates after build", () => {
      const sourceFiles = walk(join(root, "templates")).filter(
        (f) => f.endsWith(".md") || f.endsWith(".yml"),
      );
      expect(sourceFiles.length).toBeGreaterThan(0);
      for (const f of sourceFiles) {
        const rel = relative(join(root, "templates"), f);
        const packed = join(root, "dist", "templates", rel);
        expect(existsSync(packed), `dist/templates/${rel} missing; run npm run build`).toBe(true);
        expect(
          readFileSync(packed, "utf8"),
          `dist/templates/${rel} stale; run npm run build`,
        ).toBe(readFileSync(f, "utf8"));
      }
    });

    it("passes the same forbidden-reference checks as the source templates", () => {
      const distFiles = walk(join(root, "dist", "templates")).filter(
        (f) => f.endsWith(".md") || f.endsWith(".yml"),
      );
      expect(distFiles.length).toBeGreaterThan(0);
      const findings: string[] = [];
      for (const f of distFiles) {
        for (const finding of findingsFor(readFileSync(f, "utf8"))) {
          findings.push(`${relative(root, f)}: ${finding}`);
        }
      }
      expect(findings).toEqual([]);
    });
  });
});
