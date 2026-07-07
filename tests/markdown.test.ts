import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const publicDir = join(process.cwd(), "public");

/**
 * Load the browser renderer module in a DOM-free vm sandbox so the security
 * contract (escaping, link handling) can be exercised as real output without a
 * browser or any test dependency. The module attaches its API to `window`.
 */
async function loadMarkdownApi(): Promise<{ renderMarkdown: (md: string) => string; escapeHtml: (s: string) => string }> {
  const src = await readFile(join(publicDir, "markdown.js"), "utf8");
  const sandbox: { window: unknown; PirenMarkdown?: unknown } = { window: null };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.PirenMarkdown as { renderMarkdown: (md: string) => string; escapeHtml: (s: string) => string };
}

describe("WebUI markdown renderer (O7 W3)", () => {
  let api: { renderMarkdown: (md: string) => string; escapeHtml: (s: string) => string };

  beforeAll(async () => {
    api = await loadMarkdownApi();
  });

  it("exposes pure renderMarkdown and escapeHtml with no DOM dependency", () => {
    expect(api).toBeDefined();
    expect(typeof api.renderMarkdown).toBe("function");
    expect(typeof api.escapeHtml).toBe("function");
  });

  it("escapes raw HTML so script tags cannot execute", () => {
    const out = api.renderMarkdown("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script");
    expect(api.escapeHtml('<a href="x">b</a>')).toBe("&lt;a href=&quot;x&quot;&gt;b&lt;/a&gt;");
  });

  it("renders safe inline markdown links with a restricted scheme", () => {
    const out = api.renderMarkdown("See [Pi](https://example.com) docs.");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">Pi</a>');
  });

  it("rejects javascript: links, rendering only the label text", () => {
    const out = api.renderMarkdown("[click](javascript:alert(1))");
    expect(out).toContain("click");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("javascript:");
  });

  it("escapes quote characters inside link hrefs so they cannot break the attribute", () => {
    const out = api.renderMarkdown('[x](https://e.com/?a=1&b="onmouseover=alert)');
    // The dangerous quote is escaped, keeping it inside the href value...
    expect(out).toContain("&quot;onmouseover");
    // ...and never becomes a standalone onmouseover="..." attribute.
    expect(out).not.toContain('onmouseover="');
  });

  it("linkifies bare http/https URLs, keeping trailing punctuation outside the link", () => {
    const out = api.renderMarkdown("End at https://example.com.");
    expect(out).toContain('<a href="https://example.com"');
    expect(out).toContain(">https://example.com</a>");
    expect(out).toContain("</a>.");
  });

  it("never linkifies bare javascript: (or other non-http) URIs", () => {
    const out = api.renderMarkdown("bad javascript:alert(1) and data:text/html,x");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href=");
  });

  it("does not double-link a bare URL that is already a markdown link target or inline code", () => {
    const md = api.renderMarkdown("[https://a.com](https://a.com)");
    expect((md.match(/<a /g) || []).length).toBe(1);

    const code = api.renderMarkdown("`https://a.com`");
    expect(code).toContain("<code>https://a.com</code>");
    expect(code).not.toContain("<a");
  });

  it("renders bundle-relative .md markdown links as read-only vault links", () => {
    const out = api.renderMarkdown("See [bar](/Projects/Foo/bar.md) here.");
    expect(out).toContain('class="md-vault-link"');
    // The leading "/" is stripped for the vault target.
    expect(out).toContain('data-vault-target="Projects/Foo/bar.md"');
    expect(out).toContain(">bar</a>");
    // It is a vault link, not an external link.
    expect(out).not.toContain('target="_blank"');
    expect(out).not.toContain('href="/Projects');
  });

  it("keeps external http links as ordinary external links (not vault links)", () => {
    const out = api.renderMarkdown("See [Pi](https://example.com).");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">Pi</a>');
    expect(out).not.toContain("md-vault-link");
  });

  it("leaves relative and anchor markdown links as ordinary safe links", () => {
    const rel = api.renderMarkdown("[r](./foo.md)");
    expect(rel).toContain('<a href="./foo.md"');
    expect(rel).not.toContain("md-vault-link");

    const up = api.renderMarkdown("[u](../bar.md)");
    expect(up).toContain('<a href="../bar.md"');
    expect(up).not.toContain("md-vault-link");

    const anchor = api.renderMarkdown("[s](#section)");
    expect(anchor).toContain('<a href="#section"');
    expect(anchor).not.toContain("md-vault-link");
  });

  it("renders wiki links as safe vault-relative links with optional labels", () => {
    const plain = api.renderMarkdown("See [[wiki/concepts/vault]].");
    expect(plain).toContain('class="md-vault-link"');
    expect(plain).toContain('data-vault-target="wiki/concepts/vault"');
    expect(plain).toContain(">wiki/concepts/vault</a>");

    const labeled = api.renderMarkdown("See [[wiki/concepts/vault|Vault]].");
    expect(labeled).toContain('data-vault-target="wiki/concepts/vault"');
    expect(labeled).toContain(">Vault</a>");
    expect(labeled).not.toContain(">wiki/concepts/vault</a>");
  });

  it("escapes characters inside wiki link targets so they cannot inject attributes", () => {
    const out = api.renderMarkdown('[[a"onmouseover=alert(1)]]');
    expect(out).toContain("&quot;");
    expect(out).not.toContain('onmouseover="');
  });

  it("renders a basic GitHub-style table with header and body rows", () => {
    const md = "| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n";
    const out = api.renderMarkdown(md);
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain("<th>Name</th>");
    expect(out).toContain("<th>Value</th>");
    expect(out).toContain("<tbody>");
    expect(out).toContain("<td>a</td>");
    expect(out).toContain("<td>1</td>");
    expect(out).toContain("<td>b</td>");
    expect(out).toContain("<td>2</td>");
    expect(out).toContain("</table>");
  });

  it("still renders headings, bold, inline code, and lists (regression)", () => {
    expect(api.renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(api.renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(api.renderMarkdown("Use `code` here")).toContain("<code>code</code>");
    const list = api.renderMarkdown("- one\n- two");
    expect(list).toContain("<ul>");
    expect(list).toContain("<li>one</li>");
  });
});

describe("WebUI markdown renderer wiring (O7 W3)", () => {
  it("loads markdown.js before app.js and exposes the renderer to app.js", async () => {
    const html = await readFile(join(publicDir, "index.html"), "utf8");
    const app = await readFile(join(publicDir, "app.js"), "utf8");
    expect(html).toMatch(/<script src="\/markdown\.js"><\/script>[\s\S]*?<script src="\/app\.js"><\/script>/);
    expect(app).toContain("PirenMarkdown");
  });

  it("opens wiki links in the Files tab via a delegated click handler", async () => {
    const app = await readFile(join(publicDir, "app.js"), "utf8");
    expect(app).toContain('closest(".md-vault-link")');
    expect(app).toMatch(/data-vault-target[\s\S]*openVaultFile/);
  });

  it("guards the wiki-link click handler so .closest is only called on Element targets", async () => {
    const app = await readFile(join(publicDir, "app.js"), "utf8");
    // The delegated handler must check the target is an Element with .closest
    // before invoking it, so a non-Element/non-closest event.target cannot throw.
    expect(app).toMatch(/typeof \w+\.closest\s*===\s*"function"\s*\?\s*\w+\.closest\("\.md-vault-link"\)/);
  });

  it("adds no new third-party dependency (stdlib vm only, no markdown package)", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    expect(Object.keys(all)).not.toContain("marked");
    expect(Object.keys(all)).not.toContain("markdown-it");
  });
});
