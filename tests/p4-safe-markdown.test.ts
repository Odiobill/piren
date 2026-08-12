import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSafeMarkdownLinkUrl,
  parseSafeMarkdown,
  SAFE_MARKDOWN_MAX_BLOCKS,
  SAFE_MARKDOWN_MAX_INLINE_NODES,
  SAFE_MARKDOWN_MAX_INPUT_UTF16,
  SAFE_MARKDOWN_MAX_LIST_DEPTH,
  SAFE_MARKDOWN_MAX_FENCE_LABEL_LENGTH,
  SAFE_MARKDOWN_OVERFLOW_NOTICE,
  type SafeMarkdownInlineNode,
  type SafeMarkdownBlock,
} from "../web/src/safe-markdown.js";

/**
 * P4 — safe ordinary agent-message Markdown (accepted
 * `conversation-safe-markdown-contract.md`, 2026-08-12): a dependency-free,
 * pure, bounded parser over ordinary durable `agent_message` bodies only.
 * Approved blocks/inline, exact link-safety matrix, adversarial fail-closed
 * literal text, hard bounds with the exact overflow notice, and static
 * no-unsafe-surface proof. Steward and C5 handoff bodies remain literal.
 */

function paragraph(text: string): SafeMarkdownBlock {
  return { type: "paragraph", children: [{ type: "text", text }] };
}

function inline(text: string): SafeMarkdownInlineNode[] {
  return [{ type: "text", text }];
}

function flattenInline(nodes: readonly SafeMarkdownInlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "code":
        out += `\`${node.text}\``;
        break;
      case "strong":
      case "emphasis":
        out += flattenInline(node.children);
        break;
      case "link":
        out += flattenInline(node.children);
        break;
    }
  }
  return out;
}

function flattenBlocks(blocks: readonly SafeMarkdownBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading" || block.type === "blockquote") {
      out += flattenInline(block.children);
    } else if (block.type === "code-block") {
      out += `${block.label}${block.text}`;
    } else {
      for (const item of block.items) {
        out += flattenInline(item.children);
        out += flattenBlocks(item.nested);
      }
    }
    out += "\n";
  }
  return out;
}

describe("parseSafeMarkdown — approved blocks", () => {
  it("renders a plain paragraph and preserves line breaks as text", () => {
    expect(parseSafeMarkdown("hello")).toEqual({ ok: true, blocks: [paragraph("hello")] });
    expect(parseSafeMarkdown("a\nb")).toEqual({ ok: true, blocks: [paragraph("a\nb")] });
    expect(parseSafeMarkdown("")).toEqual({ ok: true, blocks: [] });
  });

  it("parses ATX headings #/##/### with exactly one space; everything else stays literal", () => {
    expect(parseSafeMarkdown("# Title")).toEqual({ ok: true, blocks: [{ type: "heading", level: 1, children: inline("Title") }] });
    expect(parseSafeMarkdown("## Sub")).toEqual({ ok: true, blocks: [{ type: "heading", level: 2, children: inline("Sub") }] });
    expect(parseSafeMarkdown("### Subsub")).toEqual({ ok: true, blocks: [{ type: "heading", level: 3, children: inline("Subsub") }] });
    for (const literal of ["#Title", "#  two spaces", "#### four", "#", "###x"]) {
      expect(parseSafeMarkdown(literal)).toEqual({ ok: true, blocks: [paragraph(literal)] });
    }
  });

  it("parses unordered/ordered lists with <=3 two-space-indent nesting and deterministic type changes", () => {
    const result = parseSafeMarkdown("- a\n- b\n  - b1\n    - b1i\n- c");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { children: inline("a"), nested: [] },
          {
            children: inline("b"),
            nested: [
              {
                type: "list",
                ordered: false,
                items: [
                  {
                    children: inline("b1"),
                    nested: [
                      { type: "list", ordered: false, items: [{ children: inline("b1i"), nested: [] }] },
                    ],
                  },
                ],
              },
            ],
          },
          { children: inline("c"), nested: [] },
        ],
      },
    ]);

    const ordered = parseSafeMarkdown("1. one\n2. two\n3. three");
    expect(ordered.ok && ordered.blocks[0]).toEqual({
      type: "list",
      ordered: true,
      items: [
        { children: inline("one"), nested: [] },
        { children: inline("two"), nested: [] },
        { children: inline("three"), nested: [] },
      ],
    });

    // Type change at the same depth starts a new sibling list (deterministic).
    const mixed = parseSafeMarkdown("- a\n- b\n1. one");
    expect(mixed.ok && (mixed.blocks as SafeMarkdownBlock[])).toHaveLength(2);
  });

  it("does not treat deep or malformed list markers as lists (literal)", () => {
    for (const literal of ["      - too deep", " - odd indent", "0. zero", "1000. big", "-no space", "1.2 no marker"]) {
      expect(parseSafeMarkdown(literal)).toEqual({ ok: true, blocks: [paragraph(literal)] });
    }
    // 100. is within the approved 1..999 ordered marker range.
    expect(parseSafeMarkdown("100. ok")).toEqual({ ok: true, blocks: [{ type: "list", ordered: true, items: [{ children: inline("ok"), nested: [] }] }] });
  });

  it("parses one-level blockquotes and merges consecutive quote lines", () => {
    expect(parseSafeMarkdown("> quoted")).toEqual({ ok: true, blocks: [{ type: "blockquote", children: inline("quoted") }] });
    const merged = parseSafeMarkdown("> line one\n> line two");
    expect(merged.ok && merged.blocks[0]).toEqual({ type: "blockquote", children: [ { type: "text", text: "line one\nline two" } ] });
    // `>> nested` is not a `> ` blockquote: literal.
    expect(parseSafeMarkdown(">> nested")).toEqual({ ok: true, blocks: [paragraph(">> nested")] });
  });

  it("parses fenced code with an optional <=32 ASCII alnum/hyphen label (text only)", () => {
    expect(parseSafeMarkdown("```\ncode\n```")).toEqual({ ok: true, blocks: [{ type: "code-block", label: "", text: "code" }] });
    expect(parseSafeMarkdown("```js\nconst x = 1;\n```")).toEqual({
      ok: true,
      blocks: [{ type: "code-block", label: "js", text: "const x = 1;" }],
    });
    expect(parseSafeMarkdown("```my-lang-42\ncode\n```")).toEqual({
      ok: true,
      blocks: [{ type: "code-block", label: "my-lang-42", text: "code" }],
    });
  });

  it("rejects fence labels with spaces or overlength labels (literal) and unterminated fences fail closed", () => {
    const badSpace = parseSafeMarkdown("```bad label\nx\n```");
    expect(badSpace.ok).toBe(true);
    if (badSpace.ok) {
      // Both lines are ordinary literal paragraph text (no code block).
      expect(flattenBlocks(badSpace.blocks)).toBe("```bad label\nx\n```\n");
    }
    const longLabel = `\`\`\`${"a".repeat(SAFE_MARKDOWN_MAX_FENCE_LABEL_LENGTH + 1)}\ncode\n\`\`\``;
    const longResult = parseSafeMarkdown(longLabel);
    expect(longResult.ok).toBe(true);
    if (longResult.ok) {
      expect(flattenBlocks(longResult.blocks).split("\n")[0]).toBe(`\`\`\`${"a".repeat(SAFE_MARKDOWN_MAX_FENCE_LABEL_LENGTH + 1)}`);
    }
    // Unterminated fence: the opener is literal and following lines parse normally.
    const unterminated = parseSafeMarkdown("```\nstill literal");
    expect(unterminated.ok).toBe(true);
    if (unterminated.ok) {
      expect(flattenBlocks(unterminated.blocks)).toBe("```\nstill literal\n");
    }
    expect(SAFE_MARKDOWN_MAX_FENCE_LABEL_LENGTH).toBe(32);
  });
});

describe("parseSafeMarkdown — approved inline", () => {
  it("parses inline code, strong (**/__), emphasis (*/_) and literal malformed delimiters", () => {
    expect(parseSafeMarkdown("a `code` b")).toEqual({ ok: true, blocks: [{ type: "paragraph", children: [{ type: "text", text: "a " }, { type: "code", text: "code" }, { type: "text", text: " b" }] }] });
    expect(parseSafeMarkdown("**bold** and __also__")).toEqual({
      ok: true,
      blocks: [
        {
          type: "paragraph",
          children: [
            { type: "strong", children: inline("bold") },
            { type: "text", text: " and " },
            { type: "strong", children: inline("also") },
          ],
        },
      ],
    });
    expect(parseSafeMarkdown("*em* and _that_")).toEqual({
      ok: true,
      blocks: [
        {
          type: "paragraph",
          children: [
            { type: "emphasis", children: inline("em") },
            { type: "text", text: " and " },
            { type: "emphasis", children: inline("that") },
          ],
        },
      ],
    });
    // Unclosed delimiters and code with a newline stay literal text.
    const unclosed = parseSafeMarkdown("**never closed");
    expect(unclosed.ok && unclosed.blocks[0]).toEqual(paragraph("**never closed"));
    const codeNl = parseSafeMarkdown("a `code\nnl` b");
    expect(codeNl.ok && codeNl.blocks[0]).toEqual(paragraph("a `code\nnl` b"));
  });

  it("parses safe links with recursively parsed labels, and renders unsafe links literal", () => {
    const link = parseSafeMarkdown("[label](https://example.com)");
    expect(link.ok && link.blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "link", url: "https://example.com", children: inline("label") }],
    });
    const nested = parseSafeMarkdown("[**bold** text](https://example.com/x)");
    expect(nested.ok && nested.blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "link", url: "https://example.com/x", children: [{ type: "strong", children: inline("bold") }, { type: "text", text: " text" }] }],
    });
    // The scan is deterministic and never produces nested anchors: the
    // inner safe link parses first and the remainder stays literal text.
    const outer = parseSafeMarkdown("[a [b](https://x)](https://y)");
    expect(outer.ok && outer.blocks[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "link", url: "https://x", children: inline("a [b") },
        { type: "text", text: "](https://y)" },
      ],
    });
    // Unsafe link source stays literal (the whole [label](url) is text).
    const unsafe = parseSafeMarkdown("[x](javascript:alert(1))");
    expect(unsafe.ok && unsafe.blocks[0]).toEqual(paragraph("[x](javascript:alert(1))"));
  });

  it("unsupported Markdown (images, tables, tasks, autolinks, entities) stays literal", () => {
    const source = "![alt](https://x/i.png)\n\n| a | b |\n\n- [ ] task\n\n<https://autolink.example>";
    const result = parseSafeMarkdown(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const flat = flattenBlocks(result.blocks);
    // The image source never becomes an anchor; the table is literal lines;
    // the task marker stays literal list content; the autolink stays text.
    expect(flat).toContain("![alt](https://x/i.png)");
    expect(flat).toContain("| a | b |");
    expect(flat).toContain("[ ] task");
    expect(flat).toContain("<https://autolink.example>");
    // Entities are never decoded into markup.
    expect(parseSafeMarkdown("&lt;script&gt;")).toEqual({ ok: true, blocks: [paragraph("&lt;script&gt;")] });
  });
});

describe("isSafeMarkdownLinkUrl — exact link safety matrix", () => {
  it("allows ordinary http/https absolute URLs with a non-empty hostname", () => {
    for (const url of ["https://example.com", "http://example.com", "https://example.com/path?q=1#frag", "https://sub.example.org:8443/x", "http://127.0.0.1:7317"]) {
      expect(isSafeMarkdownLinkUrl(url), url).toBe(true);
    }
  });

  it("rejects unsafe/relative/encoded/credential/whitespace targets", () => {
    const unsafe = [
      "", "javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox", "file:///etc/passwd",
      "ftp://example.com", "/relative/path", "relative", "//example.com/x", "#fragment",
      "https://user:pass@example.com", "https://example.com/a b", "https://example.com/\t",
      "https://example.com/\u0000", " https://example.com", "http://", "https://",
      "javascript%3Aalert(1)", "JaVaScRiPt:alert(1)", "https://example.com/\n",
    ];
    for (const url of unsafe) {
      expect(isSafeMarkdownLinkUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});

describe("parseSafeMarkdown — hard bounds and the exact overflow fallback", () => {
  it("enforces the input/block/inline bounds with the deterministic overflow result", () => {
    expect(parseSafeMarkdown("a".repeat(SAFE_MARKDOWN_MAX_INPUT_UTF16))).toEqual({ ok: true, blocks: [paragraph("a".repeat(SAFE_MARKDOWN_MAX_INPUT_UTF16))] });
    expect(parseSafeMarkdown("a".repeat(SAFE_MARKDOWN_MAX_INPUT_UTF16 + 1))).toEqual({ ok: false, reason: "over-limit" });

    const manyParagraphs = Array.from({ length: SAFE_MARKDOWN_MAX_BLOCKS + 1 }, (_, index) => `p${index}`).join("\n\n");
    expect(parseSafeMarkdown(manyParagraphs)).toEqual({ ok: false, reason: "over-limit" });

    const manyInline = "`a`".repeat(SAFE_MARKDOWN_MAX_INLINE_NODES + 1);
    expect(parseSafeMarkdown(manyInline)).toEqual({ ok: false, reason: "over-limit" });
    expect(SAFE_MARKDOWN_MAX_BLOCKS).toBe(2048);
    expect(SAFE_MARKDOWN_MAX_INLINE_NODES).toBe(8192);
    expect(SAFE_MARKDOWN_MAX_INPUT_UTF16).toBe(32768);
    expect(SAFE_MARKDOWN_MAX_LIST_DEPTH).toBe(3);
  });

  it("exposes the exact visible/screen-reader overflow notice", () => {
    expect(SAFE_MARKDOWN_OVERFLOW_NOTICE).toBe("Markdown formatting unavailable for this long message.");
  });
});

describe("P4 static boundary", () => {
  const webSrc = join(process.cwd(), "web", "src");

  it("the pure parser is self-contained: no React, DOM, network, storage, or sanitizer surface", async () => {
    const core = await readFile(join(webSrc, "safe-markdown.ts"), "utf8");
    for (const forbidden of ["react", "fetch(", "localStorage", "sessionStorage", "new EventSource", "document.", "innerHTML", "sanitize", "/api/"]) {
      expect(core, `safe-markdown.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the React renderer builds elements only: no dangerouslySetInnerHTML/HTML string, safe anchors, exact notice", async () => {
    const renderer = await readFile(join(webSrc, "SafeMarkdown.tsx"), "utf8");
    expect(renderer).not.toContain("dangerouslySetInnerHTML");
    expect(renderer).not.toContain("innerHTML");
    expect(renderer).not.toContain("outerHTML");
    expect(renderer).toContain('target="_blank"');
    expect(renderer).toContain('rel="noopener noreferrer"');
    expect(renderer).toContain("opens in a new tab");
    // The exact notice constant is pinned in the pure tests; the renderer
    // must consume the shared constant (never a duplicated literal string).
    expect(renderer).toContain("SAFE_MARKDOWN_OVERFLOW_NOTICE");
  });

  it("the transcript renders Markdown only for ordinary agent bodies; steward and handoff stay literal", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    expect(timeline).toContain("SafeMarkdownBody");
    expect(timeline).toContain('text={event.body}');
    // The steward branch keeps the literal body; handoff evidence is literal too.
    const stewardSection = timeline.slice(timeline.indexOf("const steward ="), timeline.length);
    expect(stewardSection).toContain("{event.body}");
  });

  it("no new Markdown/sanitizer dependency is introduced", async () => {
    const pkg = await readFile(join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(pkg) as { dependencies: Record<string, string> };
    for (const name of ["markdown", "marked", "remark", "micromark", "dompurify", "sanitize-html", "react-markdown"]) {
      expect(parsed.dependencies[name] === undefined, `${name} must not be added`).toBe(true);
    }
  });
});
