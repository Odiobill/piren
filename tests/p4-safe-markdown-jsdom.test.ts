// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeMarkdownBody } from "../web/src/SafeMarkdown.js";
import { SAFE_MARKDOWN_OVERFLOW_NOTICE } from "../web/src/safe-markdown.js";

/**
 * P4 — jsdom proof that the safe Markdown renderer builds React elements
 * only: approved blocks/inline map to the bounded semantic DOM (h4–h6, never
 * a page h1), safe links get exact href/target/rel + external-link indication,
 * adversarial payloads (raw HTML/SVG/script/style/event handlers) never create
 * executable or injected nodes, unsafe links stay literal, and the hard-bound
 * overflow renders the whole original body literally with the exact notice.
 */

function render(element: ReactElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return root;
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container?.remove();
});

function renderBody(text: string): Root {
  return render(createElement(SafeMarkdownBody, { text }));
}

describe("SafeMarkdownBody — approved rendering (jsdom)", () => {
  it("maps agent body headings to h4/h5/h6 and never introduces a page h1", () => {
    const root = renderBody("# H1-style\n\n## H2-style\n\n### H3-style");
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(container.querySelector("h4")?.textContent).toBe("H1-style");
    expect(container.querySelector("h5")?.textContent).toBe("H2-style");
    expect(container.querySelector("h6")?.textContent).toBe("H3-style");
    act(() => root.unmount());
  });

  it("renders paragraphs, strong, emphasis, inline code, lists, quotes, and fenced code as elements", () => {
    const root = renderBody("para **bold** *em* `code`\n\n- one\n- two\n\n> quote\n\n```js\nconst x = 1;\n```");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("ul")?.children).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toBe("quote");
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("code")?.textContent).toBe("const x = 1;");
    expect(pre?.textContent).toContain("js");
    act(() => root.unmount());
  });

  it("renders a safe link with exact href/target/rel and an accessible external-link indication", () => {
    const root = renderBody("[docs](https://example.com/guide)");
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("https://example.com/guide");
    expect(anchor!.getAttribute("target")).toBe("_blank");
    expect(anchor!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor!.textContent).toContain("docs");
    expect(anchor!.textContent).toContain("opens in a new tab");
    // No click/redirect/prefetch handlers.
    expect(anchor!.hasAttribute("onclick")).toBe(false);
    expect(anchor!.getAttribute("rel")).not.toMatch(/prefetch|noreferrer-replace/);
    act(() => root.unmount());
  });

  it("never creates nodes from raw HTML/SVG/script/style/event-handler text", () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const root = renderBody("<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n<svg onload=alert(3)></svg>\n\n<style>body{display:none}</style>\n\n<a href=\"javascript:alert(4)\">x</a>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    // Raw tag text is preserved literally as text.
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<script>");
    act(() => root.unmount());
    alertSpy.mockRestore();
  });

  it("renders unsafe/malformed links as literal source text, never anchors", () => {
    const root = renderBody("[x](javascript:alert(1)) [y](data:text/html,hi) [z](/relative) [w](https://user:pass@example.com)");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toContain("[x](javascript:alert(1))");
    expect(container.textContent).toContain("[w](https://user:pass@example.com)");
    act(() => root.unmount());
  });

  it("overflow renders the ENTIRE original body literally with the exact screen-reader notice", () => {
    const long = "a".repeat(33_000);
    const root = renderBody(long);
    const notice = Array.from(container.querySelectorAll("[role='status']")).find((el) => el.textContent === SAFE_MARKDOWN_OVERFLOW_NOTICE);
    expect(notice).toBeDefined();
    expect(container.textContent).toContain(long);
    expect(container.querySelector("h4, h5, h6, strong, em, a, pre, ul, ol, blockquote")).toBeNull();
    act(() => root.unmount());
  });
});
