import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * P4b: public registry-install and update-copy contract.
 *
 * Locks the operator-facing install/update guidance to the canonical scoped
 * registry command (`npm install -g @odiobill/piren`) and confines the legacy
 * GitHub/git-dependency install (`npm install -g --install-links github:...`)
 * and `--install-links` to explicitly labelled contributor / emergency /
 * clean-install escape-hatch context. Formatting-tolerant: it walks the real
 * files and applies context-window checks, never snapshot-matching frozen text.
 *
 * This complements `tests/public-docs-boundary.test.ts` (vault-link hygiene);
 * it does not duplicate it.
 */

const root = process.cwd();

function read(rel: string): string {
  return existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
}

const README = read("README.md");
const GETTING_STARTED = read("docs/getting-started.md");
const OPERATIONS = read("docs/operations.md");
const SECURITY = read("docs/security.md");
const TROUBLESHOOTING = read("docs/troubleshooting.md");
const SITE = read("site/index.html");
const AGENTS = read("AGENTS.md");

const REGISTRY_INSTALL = "npm install -g @odiobill/piren";
const SCOPED_UNINSTALL = "npm uninstall -g @odiobill/piren";
/** The default GitHub operator install command (git-dependency form). */
const GITHUB_INSTALL_RE = /npm\s+install\s+-g\s+--install-links\s+github:Odiobill\/piren/;
/** Unscoped uninstall only — does not match `@odiobill/piren`. */
const UNSCOPED_UNINSTALL_RE = /npm\s+uninstall\s+-g\s+piren(?![/@\w-])/;
const INSTALL_LINKS_RE = /--install-links/;

/** Keywords that label contributor / emergency / escape-hatch / git-only material. */
const CONTEXT_KEYWORDS = [
  "contributor",
  "emergency",
  "escape hatch",
  "escape-hatch",
  "clean-install",
  "clean install",
  "git global",
  "github install",
  "local checkout",
  "tarball",
  "release artifact",
  "release artifacts",
  "verify from source",
  "legacy",
  "eallowgit",
  "npm 11",
  "git-dependency",
  "git dependency",
  "git/github",
  "old github",
  "migration",
];

/** Return the ±window line blocks surrounding every match of `pattern`. */
function contextBlocks(content: string, pattern: RegExp, window: number): string[] {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  lines.forEach((line, index) => {
    if (pattern.test(line)) {
      const start = Math.max(0, index - window);
      const end = Math.min(lines.length, index + window + 1);
      blocks.push(lines.slice(start, end).join("\n"));
    }
  });
  return blocks;
}

function isLabelledContext(block: string): boolean {
  const lower = block.toLowerCase();
  return CONTEXT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

describe("P4b: public registry-install/update copy contract", () => {
  it("primary operator pages present the canonical registry install command", () => {
    expect(README).toContain(REGISTRY_INSTALL);
    expect(GETTING_STARTED).toContain(REGISTRY_INSTALL);
    expect(OPERATIONS).toContain(REGISTRY_INSTALL);
    expect(SITE).toContain(REGISTRY_INSTALL);
    // The landing page has two install CTAs; both must use the registry command.
    const siteRegistryCount = (SITE.match(/npm install -g @odiobill\/piren/g) ?? []).length;
    expect(siteRegistryCount).toBeGreaterThanOrEqual(2);
  });

  it("pure operator entry surfaces (README, landing page) do not present the GitHub command as default", () => {
    for (const [name, content] of [
      ["README.md", README],
      ["site/index.html", SITE],
    ] as Array<[string, string]>) {
      const hits = content.match(new RegExp(GITHUB_INSTALL_RE.source, "g"));
      expect(hits ?? [], `${name} must not present the GitHub install command as the default`).toEqual([]);
    }
  });

  it("GitHub install command and --install-links appear only in labelled contributor/emergency/escape-hatch context", () => {
    const audited: Array<[string, string]> = [
      ["docs/getting-started.md", GETTING_STARTED],
      ["docs/operations.md", OPERATIONS],
      ["docs/troubleshooting.md", TROUBLESHOOTING],
      ["docs/security.md", SECURITY],
      ["AGENTS.md", AGENTS],
    ];
    for (const [name, content] of audited) {
      for (const block of contextBlocks(content, GITHUB_INSTALL_RE, 10)) {
        expect(
          isLabelledContext(block),
          `${name}: GitHub install command must sit in contributor/emergency/escape-hatch context`,
        ).toBe(true);
      }
      for (const block of contextBlocks(content, INSTALL_LINKS_RE, 10)) {
        expect(
          isLabelledContext(block),
          `${name}: --install-links must sit in contributor/emergency/escape-hatch context`,
        ).toBe(true);
      }
    }
  });

  it("piren update public guidance names registry latest and the --yes major opt-in", () => {
    for (const [name, content] of [
      ["README.md", README],
      ["docs/getting-started.md", GETTING_STARTED],
      ["docs/operations.md", OPERATIONS],
    ] as Array<[string, string]>) {
      expect(content, `${name} should document the --yes major opt-in`).toContain("--yes");
      expect(content.toLowerCase(), `${name} should reference the registry latest channel`).toContain("latest");
    }
  });

  it("piren update operations guidance guarantees no automatic rollback, not a no-state-change guarantee", () => {
    // npm global install is not transactional: a failed install may already have
    // changed state. P4a only guarantees no automatic rollback, so the public
    // copy must not claim the install is left unchanged.
    expect(OPERATIONS.toLowerCase()).toContain("automatic rollback");
    expect(OPERATIONS).not.toContain("without changing your install");
  });

  it("keeps the Pi-on-PATH / separate-runtime boundary visible", () => {
    expect(README.toLowerCase()).toContain("path");
    expect(GETTING_STARTED.toLowerCase()).toContain("path");
  });

  it("distinguishes standard scoped uninstall from legacy unscoped migration cleanup", () => {
    expect(OPERATIONS).toContain(SCOPED_UNINSTALL);
    // Any unscoped uninstall must be labelled as legacy/manual migration, never
    // presented as the normal cleanup command.
    for (const block of contextBlocks(OPERATIONS, UNSCOPED_UNINSTALL_RE, 8)) {
      expect(
        isLabelledContext(block),
        "unscoped `npm uninstall -g piren` must be labelled legacy/manual migration",
      ).toBe(true);
    }
  });
});
