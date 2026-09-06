import { describe, expect, it } from "vitest";
import {
  parseVaultDocumentRelativeHref,
  parseVaultMarkdownHref,
  parseVaultWikiLink,
  resolveVaultMarkdownTarget,
} from "../web/src/vault-links.js";

/**
 * S9 (0.2.5 final Workbench refinement contract) — practical safe Vault
 * Explorer links. Spaces are valid vault-path characters, so the closed
 * parser now accepts ordinary spaces inside wikilink path segments, resolves
 * safely percent-encoded spaces in Markdown destinations (never a literal
 * `%20` filename), and adds bounded document-relative Markdown page
 * resolution from the current open document's parent. Every hostile form
 * keeps failing closed exactly as before.
 *
 * Real grounded shape: `Projects/False Finish/index.md` body links such as
 * `[[Projects/False Finish/plans/initial-product-brief]]`.
 */

function expectOkPath(result: { ok: boolean; path?: string; reason?: string }): string {
  if (!result.ok || typeof result.path !== "string") {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  return result.path;
}

describe("S9 — wikilinks accept ordinary spaces in path segments", () => {
  it("accepts the exact grounded Projects/False Finish wikilink shape", () => {
    const result = parseVaultWikiLink("Projects/False Finish/plans/initial-product-brief");
    expect(result.ok).toBe(true);
    expect(expectOkPath(result)).toBe("Projects/False Finish/plans/initial-product-brief.md");
  });

  it("keeps the piped label with spaced paths working", () => {
    const result = parseVaultWikiLink("Projects/False Finish/index|False Finish index");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("Projects/False Finish/index.md");
      expect(result.label).toBe("False Finish index");
    }
  });

  it("accepts multiple spaced segments and explicit .md extensions with spaces", () => {
    expect(expectOkPath(parseVaultWikiLink("a b/c d/e f.md"))).toBe("a b/c d/e f.md");
    expect(expectOkPath(parseVaultWikiLink("False Finish"))).toBe("False Finish.md");
  });

  it("still rejects traversal, hidden, backslash, control, query, fragment, and empty-segment spaced-path neighbors", () => {
    expect(parseVaultWikiLink("False Finish/../secret").ok).toBe(false);
    expect(parseVaultWikiLink("a b//c").ok).toBe(false);
    expect(parseVaultWikiLink(".hidden dir/x").ok).toBe(false);
    expect(parseVaultWikiLink("a b\\c").ok).toBe(false);
    expect(parseVaultWikiLink("a\tb").ok).toBe(false);
    expect(parseVaultWikiLink("a b?x").ok).toBe(false);
    expect(parseVaultWikiLink("a b#f").ok).toBe(false);
    expect(parseVaultWikiLink("a \u0000b").ok).toBe(false);
    expect(parseVaultWikiLink("dir/ /x").ok).toBe(false);
  });

  it("rejects ambiguous leading/trailing spaces inside a segment (inner spaces stay valid)", () => {
    expect(parseVaultWikiLink("Projects/False Finish /index").ok).toBe(false);
    expect(parseVaultWikiLink("Projects/ False Finish/index").ok).toBe(false);
  });
});

describe("S9 — safely encoded spaces in Markdown destinations", () => {
  it("resolves %20 to the real vault path, never a literal %20 filename", () => {
    expect(expectOkPath(parseVaultMarkdownHref("/Projects/False%20Finish/index.md"))).toBe(
      "Projects/False Finish/index.md",
    );
    expect(expectOkPath(parseVaultMarkdownHref("/Projects/Piren/implementation%20plan.md"))).toBe(
      "Projects/Piren/implementation plan.md",
    );
  });

  it("rejects malformed percent-encoding and decoded separators/traversal/controls", () => {
    // A lone encoded space at the end of a segment is an ambiguous trailing
    // space in the decoded filename.
    expect(parseVaultMarkdownHref("/Projects/Piren/a%20").ok).toBe(false);
    expect(parseVaultMarkdownHref("/Projects/Piren/a%ZZb.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/Projects/Piren/a%2").ok).toBe(false);
    // Decoded separator (%2F), backslash (%5C), dot (%2E), and control (%00).
    expect(parseVaultMarkdownHref("/a%2Fb.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a%5Cb.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a%2Eb.md").ok).toBe(false);
    expect(parseVaultMarkdownHref("/a%00b.md").ok).toBe(false);
  });

  it("keeps raw spaces in Markdown destinations rejected (encoded form is the safe spelling)", () => {
    expect(parseVaultMarkdownHref("/Projects/False Finish/index.md").ok).toBe(false);
  });
});

describe("S9 — bounded document-relative Markdown page resolution", () => {
  const DOC = "Projects/False Finish/index.md";

  it("resolves sibling and descendant Markdown destinations from the document parent", () => {
    expect(expectOkPath(parseVaultDocumentRelativeHref("log.md", DOC))).toBe("Projects/False Finish/log.md");
    expect(
      expectOkPath(parseVaultDocumentRelativeHref("plans/initial-product-brief.md", DOC)),
    ).toBe("Projects/False Finish/plans/initial-product-brief.md");
  });

  it("resolves from a root-level document (parent is the vault root)", () => {
    expect(expectOkPath(parseVaultDocumentRelativeHref("team/notes.md", "index.md"))).toBe("team/notes.md");
    // Encoded spaces resolve; raw spaces in Markdown destinations stay rejected.
    expect(expectOkPath(parseVaultDocumentRelativeHref("team/a%20b/page.md", "index.md"))).toBe("team/a b/page.md");
    expect(parseVaultDocumentRelativeHref("team/a b/page.md", "index.md").ok).toBe(false);
  });

  it("drops single-dot segments (bounded, cannot escape) and resolves encoded spaces", () => {
    expect(expectOkPath(parseVaultDocumentRelativeHref("./log.md", DOC))).toBe("Projects/False Finish/log.md");
    expect(expectOkPath(parseVaultDocumentRelativeHref("plans/./x.md", DOC))).toBe(
      "Projects/False Finish/plans/x.md",
    );
    expect(expectOkPath(parseVaultDocumentRelativeHref("False%20Finish/x.md", "index.md"))).toBe(
      "False Finish/x.md",
    );
  });

  it("fails closed on dot traversal in any position", () => {
    expect(parseVaultDocumentRelativeHref("../escape.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("plans/../../escape.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a/../b.md", DOC).ok).toBe(false);
  });

  it("fails closed on non-Markdown, hidden, backslash, control, query/fragment, and empty targets", () => {
    expect(parseVaultDocumentRelativeHref("notes.txt", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("plans/initial-product-brief", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref(".hidden.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a\\b.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a\u0000b.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a?b.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a#f.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a//b.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("./", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("a b.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("False%ZZ/x.md", DOC).ok).toBe(false);
  });

  it("rejects absolute-URL and scheme-like targets as not document-relative", () => {
    expect(parseVaultDocumentRelativeHref("//example.com/x.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("javascript:payload.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("mailto:notes.md", DOC).ok).toBe(false);
    expect(parseVaultDocumentRelativeHref("custom+scheme:page.md", DOC).ok).toBe(false);
  });
});

describe("S9 — combined resolver dispatch", () => {
  it("routes root-relative targets verbatim and relative targets through the document parent", () => {
    expect(expectOkPath(resolveVaultMarkdownTarget("/Projects/Piren/x.md", "index.md"))).toBe("Projects/Piren/x.md");
    expect(expectOkPath(resolveVaultMarkdownTarget("plans/brief.md", "Projects/False Finish/index.md"))).toBe(
      "Projects/False Finish/plans/brief.md",
    );
  });

  it("fails closed for relative targets without a current document", () => {
    expect(resolveVaultMarkdownTarget("plans/brief.md", null).ok).toBe(false);
  });

  it("keeps root-relative hostile targets failing closed regardless of document context", () => {
    expect(resolveVaultMarkdownTarget("/../secret.md", "index.md").ok).toBe(false);
    expect(resolveVaultMarkdownTarget("/a%2Fb.md", "index.md").ok).toBe(false);
  });
});
