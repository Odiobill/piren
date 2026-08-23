// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  parseSafeMarkdown,
  parseSafeMarkdownWithVaultLinks,
  type SafeMarkdownBlock,
} from "../web/src/safe-markdown.js";

/**
 * WUX-C — Vault-specific link recognition is an explicit, narrowly
 * parameterized mode. The default ordinary-message parser NEVER produces
 * vault-link nodes (byte-compatible Conversation behavior); only
 * `parseSafeMarkdownWithVaultLinks` recognizes the two closed vault-page
 * forms (root-relative `[label](/path.md)` links and `[[target]]` /
 * `[[target|label]]` wikilinks). External http(s) links keep their existing
 * safe-link node in BOTH modes; every rejected/unsupported form stays
 * literal text.
 */

function inlineTypes(blocks: readonly SafeMarkdownBlock[], index = 0): string[] {
  const block = blocks[index];
  if (block === undefined || block.type !== "paragraph") throw new Error("expected paragraph block");
  return block.children.map((node) => node.type);
}

describe("parseSafeMarkdown (default mode) — byte-compatible conversation behavior", () => {
  it("never recognizes root-relative or wiki vault links (they stay literal text)", () => {
    const result = parseSafeMarkdown("See [Plan](/Projects/Piren/plan.md) and [[Projects/Piren/plan]].");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No link node at all: the whole body remains literal text runs.
      expect(inlineTypes(result.blocks)).toEqual(["text"]);
      const block = result.blocks[0];
      if (block?.type === "paragraph") {
        const text = block.children.map((node) => (node.type === "text" ? node.text : "")).join("");
        expect(text).toBe("See [Plan](/Projects/Piren/plan.md) and [[Projects/Piren/plan]].");
      }
    }
  });
});

describe("parseSafeMarkdownWithVaultLinks — closed vault-page forms", () => {
  it("recognizes a safe root-relative Markdown link as a vault-link with its path", () => {
    const result = parseSafeMarkdownWithVaultLinks("Read [Plan](/Projects/Piren/implementation-plan.md).");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.blocks[0];
    if (block?.type !== "paragraph") throw new Error("expected paragraph");
    expect(inlineTypes(result.blocks)).toEqual(["text", "vault-link", "text"]);
    const link = block.children[1];
    if (link?.type !== "vault-link") throw new Error("expected vault-link");
    expect(link.path).toBe("Projects/Piren/implementation-plan.md");
    // Label children are parsed inline without nested links.
    expect(link.children.map((node) => (node.type === "text" ? node.text : ""))).toEqual(["Plan"]);
  });

  it("recognizes both wikilink forms including the piped label", () => {
    const bare = parseSafeMarkdownWithVaultLinks("[[Projects/Piren/plan]]");
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      const block = bare.blocks[0];
      if (block?.type !== "paragraph") throw new Error("expected paragraph");
      const link = block.children[0];
      if (link?.type !== "vault-link") throw new Error("expected vault-link");
      expect(link.path).toBe("Projects/Piren/plan.md");
      expect(link.children.map((node) => (node.type === "text" ? node.text : ""))).toEqual(["Projects/Piren/plan"]);
    }
    const labelled = parseSafeMarkdownWithVaultLinks("[[Projects/Piren/plan|Plan]]");
    expect(labelled.ok).toBe(true);
    if (labelled.ok) {
      const block = labelled.blocks[0];
      if (block?.type !== "paragraph") throw new Error("expected paragraph");
      const link = block.children[0];
      if (link?.type !== "vault-link") throw new Error("expected vault-link");
      expect(link.path).toBe("Projects/Piren/plan.md");
      expect(link.children.map((node) => (node.type === "text" ? node.text : ""))).toEqual(["Plan"]);
    }
  });

  it("keeps external http(s) links as ordinary safe links in vault mode", () => {
    const result = parseSafeMarkdownWithVaultLinks("Visit [docs](https://example.com/a).");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(inlineTypes(result.blocks)).toEqual(["text", "link", "text"]);
      const block = result.blocks[0];
      if (block?.type === "paragraph") {
        const link = block.children[1];
        if (link?.type === "link") expect(link.url).toBe("https://example.com/a");
        else throw new Error("expected ordinary link node");
      }
    }
  });

  it("leaves rejected targets as literal text exactly", () => {
    for (const body of [
      "[evil](../secret.md)",
      "[rel](Projects/Piren/plan.md)",
      "[[../escape]]",
      "[[a|b|c]]",
      "[[unclosed",
      "[empty]()",
    ]) {
      const result = parseSafeMarkdownWithVaultLinks(body);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const block of result.blocks) {
        if (block.type !== "paragraph") continue;
        for (const node of block.children) {
          expect(node.type).not.toBe("vault-link");
        }
        const text = block.children.map((node) => (node.type === "text" ? node.text : "")).join("");
        expect(text).toContain(body.startsWith("[[") ? body.replace(/]$/, "") : body.split(" ")[0]);
      }
    }
  });

  it("still enforces the hard rendering bounds in vault mode", () => {
    expect(parseSafeMarkdownWithVaultLinks("x".repeat(32769)).ok).toBe(false);
  });
});
