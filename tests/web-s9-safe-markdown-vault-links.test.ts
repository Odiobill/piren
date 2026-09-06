import { describe, expect, it } from "vitest";
import {
  parseSafeMarkdown,
  parseSafeMarkdownWithVaultLinks,
  type SafeMarkdownBlock,
  type SafeMarkdownInlineNode,
} from "../web/src/safe-markdown.js";

/**
 * S9 — the explicit Vault parser mode gains bounded document-relative
 * Markdown resolution (from the current open document) while the default
 * ordinary Conversation parser keeps byte-compatible behavior: it never
 * emits vault-link nodes for any form, including spaced wikilinks and
 * document-relative Markdown destinations.
 */

const DOC = "Projects/False Finish/index.md";

/** Deterministic, optional-free inline summary for behavior assertions. */
function inlineSummary(node: SafeMarkdownInlineNode): string {
  if (node.type === "text") return `text(${JSON.stringify(node.text)})`;
  if (node.type === "vault-link") return `vault-link(${node.path})`;
  if (node.type === "link") return `link(${node.url})`;
  return node.type;
}

function firstParagraphSummaries(blocks: readonly SafeMarkdownBlock[]): string[] {
  const block = blocks[0];
  if (block === undefined || block.type !== "paragraph") throw new Error("expected paragraph block");
  return block.children.map(inlineSummary);
}

describe("Conversation mode regression — no vault navigation authority", () => {
  it("never emits vault-link nodes for spaced wikilinks, relative, or encoded-space destinations", () => {
    const bodies = [
      "[[Projects/False Finish/plans/initial-product-brief]]",
      "See [Brief](plans/initial-product-brief.md) here.",
      "See [Index](/Projects/False%20Finish/index.md) here.",
      "[[Projects/False Finish/index|FF]]",
    ];
    for (const body of bodies) {
      const result = parseSafeMarkdown(body);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const block of result.blocks) {
        if (block.type !== "paragraph") continue;
        for (const node of block.children) {
          expect(node.type, body).not.toBe("vault-link");
        }
      }
    }
  });

  it("keeps the default parser output byte-compatible for the grounded False Finish body", () => {
    const body = "- [[Projects/False Finish/plans/initial-product-brief]] — Approved initial product direction";
    const result = parseSafeMarkdown(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.blocks[0];
    if (block?.type !== "list") throw new Error("expected list");
    const text = block.items[0]?.children.map((node) => (node.type === "text" ? node.text : "")).join("") ?? "";
    expect(text).toBe("[[Projects/False Finish/plans/initial-product-brief]] — Approved initial product direction");
  });
});

describe("Vault mode — grounded False Finish wikilink shape with the document context", () => {
  it("produces an in-place vault-link with the resolved .md path for the exact grounded link", () => {
    const result = parseSafeMarkdownWithVaultLinks(
      "- [[Projects/False Finish/plans/initial-product-brief]] — Approved initial product direction",
      { documentPath: DOC },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.blocks[0];
    if (block?.type !== "list") throw new Error("expected list");
    const link = block.items[0]?.children[0];
    if (link?.type !== "vault-link") throw new Error("expected vault-link");
    expect(link.path).toBe("Projects/False Finish/plans/initial-product-brief.md");
  });

  it("supports the piped label form with spaced paths", () => {
    const result = parseSafeMarkdownWithVaultLinks("[[Projects/False Finish/index|False Finish]]", { documentPath: DOC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const link = result.blocks[0];
    if (link?.type !== "paragraph" || link.children[0]?.type !== "vault-link") throw new Error("expected vault-link");
    const vaultLink = link.children[0];
    if (vaultLink.type !== "vault-link") throw new Error("expected vault-link");
    expect(vaultLink.path).toBe("Projects/False Finish/index.md");
    expect(vaultLink.children.map((node) => (node.type === "text" ? node.text : ""))).toEqual(["False Finish"]);
  });
});

describe("Vault mode — document-relative and encoded-space Markdown destinations", () => {
  it("resolves a sibling destination against the current document parent", () => {
    const result = parseSafeMarkdownWithVaultLinks("Read [log](log.md) next.", { documentPath: DOC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(firstParagraphSummaries(result.blocks)).toEqual([
      'text("Read ")',
      "vault-link(Projects/False Finish/log.md)",
      'text(" next.")',
    ]);
  });

  it("resolves an encoded-space root-relative destination to the real vault path", () => {
    const result = parseSafeMarkdownWithVaultLinks("Open [Index](/Projects/False%20Finish/index.md).", {
      documentPath: DOC,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summaries = firstParagraphSummaries(result.blocks);
    expect(summaries[1]).toBe("vault-link(Projects/False Finish/index.md)");
  });

  it("keeps hostile destinations literal even with a document context", () => {
    for (const body of [
      "[x](../escape.md)",
      "[x](/a%2Fb.md)",
      "[x](notes.txt)",
      "[x](a//b.md)",
      "[[../escape]]",
    ]) {
      const result = parseSafeMarkdownWithVaultLinks(body, { documentPath: DOC });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const block = result.blocks[0];
      if (block?.type !== "paragraph") continue;
      for (const node of block.children) {
        expect(node.type, body).not.toBe("vault-link");
      }
    }
  });

  it("fails closed for document-relative destinations when no document context is given", () => {
    const result = parseSafeMarkdownWithVaultLinks("Read [log](log.md) next.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.blocks[0];
    if (block?.type !== "paragraph") return;
    for (const node of block.children) expect(node.type).not.toBe("vault-link");
  });
});
