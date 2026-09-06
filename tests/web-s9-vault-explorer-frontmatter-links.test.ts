import { describe, expect, it } from "vitest";
import { isSafeMarkdownLinkUrl } from "../web/src/safe-markdown.js";
import { presentFrontmatterLinkValues, type FrontmatterField } from "../web/src/vault-explorer.js";

/**
 * S9 — the recognized top-level frontmatter `links:` field becomes
 * interactive metadata presentation: internal vault Markdown targets navigate
 * in place, safe absolute HTTP(S) targets are new-tab anchors, and every
 * unsupported value stays plain text. Arbitrary scalar fields never become
 * links. An array of links stays individually operable and readable.
 */

function field(key: string, value: FrontmatterField["value"]): FrontmatterField {
  return { key, value };
}

type Classified = ReturnType<typeof presentFrontmatterLinkValues>;

function expectKinds(result: Classified, kinds: readonly string[]): void {
  expect(result).not.toBeNull();
  expect(result?.map((entry) => entry.kind)).toEqual(kinds);
}

describe("presentFrontmatterLinkValues — only the recognized links field", () => {
  it("returns null for every other field so arbitrary scalars never become links", () => {
    expect(presentFrontmatterLinkValues(field("title", "Hello"), "index.md")).toBeNull();
    expect(presentFrontmatterLinkValues(field("tags", ["a", "b"]), "index.md")).toBeNull();
    expect(presentFrontmatterLinkValues(field("href", "/x.md"), "index.md")).toBeNull();
  });
});

describe("presentFrontmatterLinkValues — internal vault Markdown targets", () => {
  it("classifies the real root-relative bundle links as in-place vault navigation", () => {
    const result = presentFrontmatterLinkValues(
      field("links", ["/Projects/Piren/0-2-5-roadmap.md", "/Projects/Piren/handoff-prompt.md"]),
      "Projects/Piren/0-2-5-final-workbench-refinement-contract.md",
    );
    expectKinds(result, ["vault", "vault"]);
    expect(result?.[0]).toEqual({ kind: "vault", path: "Projects/Piren/0-2-5-roadmap.md", label: "Projects/Piren/0-2-5-roadmap.md" });
    expect(result?.[1]?.kind).toBe("vault");
  });

  it("resolves encoded spaces to the real vault path in metadata values", () => {
    const result = presentFrontmatterLinkValues(field("links", "/Projects/False%20Finish/index.md"), "index.md");
    expectKinds(result, ["vault"]);
    expect(result?.[0]?.kind === "vault" && result[0].path).toBe("Projects/False Finish/index.md");
  });

  it("classifies document-relative internal targets from the current document parent", () => {
    const result = presentFrontmatterLinkValues(
      field("links", ["plans/initial-product-brief.md", "log.md"]),
      "Projects/False Finish/index.md",
    );
    expectKinds(result, ["vault", "vault"]);
    expect(result?.[0]?.kind === "vault" && result[0].path).toBe(
      "Projects/False Finish/plans/initial-product-brief.md",
    );
  });

  it("keeps hostile internal candidates non-interactive", () => {
    const result = presentFrontmatterLinkValues(
      field("links", ["/../secret.md", "/a%2Fb.md", "/team/x.txt", "a//b.md"]),
      "index.md",
    );
    expectKinds(result, ["text", "text", "text", "text"]);
  });
});

describe("presentFrontmatterLinkValues — safe external HTTP(S) anchors", () => {
  it("classifies absolute http/https values as external anchors", () => {
    const result = presentFrontmatterLinkValues(
      field("links", ["https://example.com/docs", "http://example.com/a"]),
      "index.md",
    );
    expectKinds(result, ["external", "external"]);
    expect(result?.[0]?.kind === "external" && result[0].url).toBe("https://example.com/docs");
  });

  it("keeps protocol-relative, credential, unsupported-scheme, and control-bearing URLs non-interactive", () => {
    const result = presentFrontmatterLinkValues(
      field("links", [
        "//example.com/x",
        "https://user:pass@example.com",
        "javascript:alert(1)",
        "javascript:payload.md",
        "mailto:notes.md",
        "ftp://example.com",
      ]),
      "index.md",
    );
    expectKinds(result, ["text", "text", "text", "text", "text", "text"]);
  });

  it("uses the shared safe-URL rule for the external decision", () => {
    expect(isSafeMarkdownLinkUrl("https://example.com/a b")).toBe(false);
  });
});

describe("presentFrontmatterLinkValues — scalar values and non-string entries", () => {
  it("supports a single scalar links value", () => {
    const result = presentFrontmatterLinkValues(field("links", "/Projects/Piren/x.md"), "index.md");
    expectKinds(result, ["vault"]);
  });

  it("renders non-string entries as plain text", () => {
    const result = presentFrontmatterLinkValues(field("links", [42, true, "https://example.com"]), "index.md");
    expectKinds(result, ["text", "text", "external"]);
    expect(result?.[0]?.kind === "text" && result[0].text).toBe("42");
    expect(result?.[1]?.kind === "text" && result[1].text).toBe("true");
  });

  it("keeps relative values plain text without a current document", () => {
    const result = presentFrontmatterLinkValues(field("links", "plans/brief.md"), null);
    expectKinds(result, ["text"]);
  });
});
