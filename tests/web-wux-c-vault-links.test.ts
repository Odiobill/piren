import { describe, expect, it } from "vitest";
import { parseVaultMarkdownHref, parseVaultWikiLink } from "../web/src/vault-links.js";

/**
 * WUX-C — pure closed vault-page link target parsing for the read-only
 * Vault Explorer. Only two explicitly bounded forms ever navigate in place:
 *
 * - safe standard Markdown ROOT-RELATIVE links `[Plan](/Projects/Piren/x.md)`
 *   (used verbatim, no extension mapping);
 * - existing vault wikilinks `[[Projects/Piren/x]]` / `[[Projects/Piren/x|Plan]]`
 *   (extensionless targets map deterministically to `.md`; an explicit
 *   extension is retained).
 *
 * Everything else fails closed with an exact reason and stays literal text:
 * traversal, backslashes, protocol-relative/absolute URLs, controls,
 * query/fragment, empty/double-slash paths, and unsupported wiki syntax.
 * S9: ordinary spaces inside wikilink path segments are now valid vault
 * paths and are accepted (see tests/web-s9-vault-links.test.ts).
 * Browser-relative links are never converted into vault targets.
 */

function okPath(result: ReturnType<typeof parseVaultMarkdownHref>): string {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.path;
}

describe("parseVaultMarkdownHref — safe standard root-relative form", () => {
  it("accepts a root-relative vault page and uses the path verbatim", () => {
    expect(okPath(parseVaultMarkdownHref("/Projects/Piren/implementation-plan.md"))).toBe(
      "Projects/Piren/implementation-plan.md",
    );
    expect(okPath(parseVaultMarkdownHref("/index.md"))).toBe("index.md");
    // Standard Markdown targets keep their explicit Markdown extension.
    expect(okPath(parseVaultMarkdownHref("/team/dipu/notes.MARKDOWN"))).toBe("team/dipu/notes.MARKDOWN");
  });

  it("rejects browser-relative links (never converted)", () => {
    expect(parseVaultMarkdownHref("Projects/Piren/plan.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("./plan.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("../plan.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("plan.md").ok).toBe(false);
  });

  it("rejects traversal segments anywhere in the target", () => {
    expect(parseVaultMarkdownHref("/../secret.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/team/../secret.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a/b/../../c.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/..").ok).toBe(false);
  });

  it("rejects absolute/protocol-relative URLs and schemes", () => {
    expect(parseVaultMarkdownHref("http://example.com/x.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("https://example.com/x.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("//example.com/x.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("mailto:a@example.com").ok).toBe(false);
  });

  it("rejects non-Markdown and hidden targets so links stay vault pages, not a hidden-file browser", () => {
    expect(parseVaultMarkdownHref("/team/dipu/notes.txt").ok).toBe(false);
    expect(parseVaultMarkdownHref("/.piren-vault").ok).toBe(false);
    expect(parseVaultMarkdownHref("/team/.config.md").ok).toBe(false);
    expect(parseVaultWikiLink("team/dipu/notes.txt").ok).toBe(false);
    expect(parseVaultWikiLink(".piren-vault").ok).toBe(false);
  });

  it("rejects backslashes, controls, query/fragment, and empty/double-slash paths", () => {
    expect(parseVaultMarkdownHref("/a\\b.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a\tb.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a b.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a\u0000b.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a\u007fb.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a?b=1").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a#fragment").ok).toBe(false);
    expect(parseVaultMarkdownHref("").ok).toBe(false);
    expect(parseVaultMarkdownHref("/").ok).toBe(false);
    expect(parseVaultMarkdownHref("//a").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a//b.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a/").ok).toBe(false);
    expect(parseVaultMarkdownHref("/.").ok).toBe(false);
  });
});

describe("parseVaultWikiLink — closed vault wikilink form", () => {
  it("maps an extensionless wiki target deterministically to .md", () => {
    const result = parseVaultWikiLink("Projects/Piren/implementation-plan");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("Projects/Piren/implementation-plan.md");
      expect(result.label).toBeNull();
    }
  });

  it("keeps an explicit extension and parses an optional piped label", () => {
    const md = parseVaultWikiLink("Projects/Piren/implementation-plan.md|Plan");
    expect(md.ok).toBe(true);
    if (md.ok) {
      expect(md.path).toBe("Projects/Piren/implementation-plan.md");
      expect(md.label).toBe("Plan");
    }
    const markdown = parseVaultWikiLink("guides/a.MARKDOWN");
    expect(markdown.ok).toBe(true);
    if (markdown.ok) expect(markdown.path).toBe("guides/a.MARKDOWN");

  });

  it("appends .md exactly once for an extensionless bare name", () => {
    const result = parseVaultWikiLink("index");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("index.md");
  });

  it("rejects unsupported wiki syntax and unsafe targets", () => {
    expect(parseVaultWikiLink("").ok).toBe(false);
    expect(parseVaultWikiLink("|Label").ok).toBe(false);
    expect(parseVaultWikiLink("a|b|c").ok).toBe(false);
    expect(parseVaultWikiLink("../x").ok).toBe(false);
    expect(parseVaultWikiLink("a/../x").ok).toBe(false);
    expect(parseVaultWikiLink("a//b").ok).toBe(false);
    expect(parseVaultWikiLink("/leading-slash").ok).toBe(false);
    expect(parseVaultWikiLink("http://example.com/x").ok).toBe(false);
    expect(parseVaultWikiLink("//example.com/x").ok).toBe(false);
    expect(parseVaultWikiLink("a\\b").ok).toBe(false);
    expect(parseVaultWikiLink("a?b").ok).toBe(false);
    expect(parseVaultWikiLink("a#f").ok).toBe(false);
    expect(parseVaultWikiLink("a\u0000b").ok).toBe(false);
    // S9: "a b" is now a valid spaced vault path — see web-s9-vault-links.test.ts.
    expect(parseVaultWikiLink("a\tb").ok).toBe(false);
  });
});
