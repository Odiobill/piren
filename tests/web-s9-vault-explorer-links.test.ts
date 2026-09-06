// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VaultExplorer } from "../web/src/VaultExplorer.js";
import { SafeMarkdownBody } from "../web/src/SafeMarkdown.js";
import { fetchVaultList, fetchVaultRead } from "../web/src/api.js";
import type { VaultListResponse, VaultReadResponse } from "../web/src/vault-explorer.js";

/**
 * S9 — React/jsdom proof that recognized metadata `links:` values and body
 * wikilinks become in-place Explorer navigation with the resolved
 * vault-relative path, external metadata links are safe new-tab anchors, and
 * Conversation rendering without a navigation handler never gains vault
 * navigation controls.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchVaultList: vi.fn(),
    fetchVaultRead: vi.fn(),
  };
});

const mockedList = vi.mocked(fetchVaultList);
const mockedRead = vi.mocked(fetchVaultRead);

const FALSE_FINISH_BODY = [
  "# False Finish — Project Index",
  "",
  "## Current plans",
  "",
  "- [[Projects/False Finish/plans/initial-product-brief]] — Approved initial product direction",
  "",
].join("\n");

const FALSE_FINISH_READ: VaultReadResponse = {
  path: "Projects/False Finish/index.md",
  content: [
    "---",
    'title: "False Finish — Project Index"',
    "links:",
    "  - /Projects/Piren/0-2-5-roadmap.md",
    "  - https://example.com/spec",
    "  - /a%2Fb.md",
    "---",
    "",
    FALSE_FINISH_BODY,
  ].join("\n"),
  bytes: 300,
  mtimeMs: 1,
  capped: false,
};

const ROOT_LIST: VaultListResponse = {
  path: ".",
  entries: [{ name: "False Finish", path: "False Finish", type: "directory", mtimeMs: 2 }],
  capped: false,
};

const FALSE_FINISH_LIST: VaultListResponse = {
  path: "False Finish",
  entries: [{ name: "index.md", path: "False Finish/index.md", type: "file", bytes: 300, mtimeMs: 1 }],
  capped: false,
};

const PLANS_LIST: VaultListResponse = { path: "False Finish/plans", entries: [], capped: false };

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderExplorer(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(VaultExplorer, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
  });
  await flush();
}

function buttonWithText(label: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((b) => b.textContent?.includes(label)) ?? null;
}

function allButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockImplementation((path: string) => {
    if (path === ".") return Promise.resolve(ROOT_LIST);
    if (path === "False Finish") return Promise.resolve(FALSE_FINISH_LIST);
    if (path === "False Finish/plans") return Promise.resolve(PLANS_LIST);
    return Promise.resolve({ path, entries: [], capped: false });
  });
  mockedRead.mockImplementation((path: string) => {
    if (path === "False Finish/index.md") return Promise.resolve(FALSE_FINISH_READ);
    return Promise.resolve({ path, content: "placeholder", bytes: 1, mtimeMs: 1, capped: false });
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("Vault Explorer S9 — metadata card links are individually interactive", () => {
  it("renders recognized links values as one operable control each, not joined text", async () => {
    await renderExplorer();
    await act(async () => buttonWithText("False Finish")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    await act(async () => buttonWithText("index.md")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const card = container.querySelector(".vault-explorer-frontmatter");
    expect(card).not.toBeNull();
    // One operable control per recognized value; the unsupported value stays
    // non-interactive text.
    const controls = card?.querySelectorAll(".vault-explorer-frontmatter-link");
    expect(controls?.length).toBe(2);
    const vaultControl = card?.querySelector<HTMLButtonElement>("button.vault-explorer-frontmatter-link");
    expect(vaultControl?.textContent).toBe("Projects/Piren/0-2-5-roadmap.md");
    // The external value is a real anchor with safe new-tab attributes.
    const anchor = card?.querySelector<HTMLAnchorElement>("a.vault-explorer-frontmatter-link");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/spec");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    // The unsupported value stays non-interactive text.
    expect(card?.textContent).toContain("/a%2Fb.md");
    expect(card?.querySelector("span.vault-explorer-frontmatter-text")?.textContent).toBe("/a%2Fb.md");
  });

  it("clicking the internal metadata link navigates in place to the resolved vault path", async () => {
    await renderExplorer();
    await act(async () => buttonWithText("False Finish")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    await act(async () => buttonWithText("index.md")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    mockedRead.mockClear();

    const vaultControl = container.querySelector<HTMLButtonElement>("button.vault-explorer-frontmatter-link");
    await act(async () => vaultControl?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(mockedRead).toHaveBeenCalledWith("Projects/Piren/0-2-5-roadmap.md", "T", expect.anything());
    // The document header shows the opened document (in-place navigation).
    expect(container.querySelector(".vault-explorer-document-name")?.textContent).toBe("0-2-5-roadmap.md");
  });
});

describe("Vault Explorer S9 — body wikilinks navigate in place", () => {
  it("clicking the grounded False Finish wikilink opens the resolved sibling document", async () => {
    await renderExplorer();
    await act(async () => buttonWithText("False Finish")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    await act(async () => buttonWithText("index.md")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    mockedRead.mockClear();

    const body = container.querySelector(".markdown-body");
    expect(body).not.toBeNull();
    const wikilink = body?.querySelector<HTMLButtonElement>("button.markdown-vault-link");
    expect(wikilink?.textContent).toBe("Projects/False Finish/plans/initial-product-brief");
    await act(async () => wikilink?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(mockedRead).toHaveBeenCalledWith(
      "Projects/False Finish/plans/initial-product-brief.md",
      "T",
      expect.anything(),
    );
    expect(container.querySelector(".vault-explorer-document-name")?.textContent).toBe(
      "initial-product-brief.md",
    );
  });
});

describe("Conversation rendering never gains vault navigation controls", () => {
  it("renders the grounded wikilink as literal text without a navigation handler", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(SafeMarkdownBody, { text: "- [[Projects/False Finish/plans/initial-product-brief]] — Approved" }));
    });
    expect(container.querySelector("button.markdown-vault-link")).toBeNull();
    expect(container.querySelector(".markdown-body")?.textContent).toContain(
      "[[Projects/False Finish/plans/initial-product-brief]]",
    );
  });
});
