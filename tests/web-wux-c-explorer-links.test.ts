// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VaultExplorer } from "../web/src/VaultExplorer.js";
import { fetchVaultList, fetchVaultRead } from "../web/src/api.js";
import type { VaultExplorerLocation, VaultListResponse, VaultReadResponse } from "../web/src/vault-explorer.js";

/**
 * WUX-C — Vault Explorer Markdown documents render closed vault-page links
 * (root-relative `[label](/path.md)` links and `[[target]]` /
 * `[[target|label]]` wikilinks) as in-place navigation over the EXISTING
 * bounded read route: clicking one opens that document, updates the
 * explorer's in-memory location/breadcrumb/back behavior, and never touches
 * the browser location, filesystem, or any new endpoint. External http(s)
 * links keep their existing safe new-tab anchors; rejected forms stay
 * literal text.
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

const ROOT_LIST: VaultListResponse = {
  path: ".",
  entries: [{ name: "notes.md", path: "notes.md", type: "file", bytes: 120, mtimeMs: 3 }],
  capped: false,
};

const NOTES_READ: VaultReadResponse = {
  path: "notes.md",
  content: [
    "See [Plan](/Projects/Piren/plan.md) and [[team/zai/log|Zai log]].",
    "",
    "External [docs](https://example.com/a) stay new-tab.",
    "",
    "Broken [evil](../secret.md) stays literal.",
  ].join("\n"),
  bytes: 220,
  mtimeMs: 4,
  capped: false,
};

const PLAN_READ: VaultReadResponse = {
  path: "Projects/Piren/plan.md",
  content: "# Plan",
  bytes: 8,
  mtimeMs: 5,
  capped: false,
};

let container: HTMLDivElement;
let root: Root;
let onLocationChange: Mock<(location: VaultExplorerLocation) => void>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderExplorer(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onLocationChange = vi.fn();
  await act(async () => {
    root.render(createElement(VaultExplorer, { token: "T", onUnauthorized: () => {}, onValidated: () => {}, onLocationChange }));
  });
}

function buttonWithLabel(label: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((b) => b.getAttribute("aria-label")?.includes(label) || b.textContent?.includes(label)) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue(ROOT_LIST);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("VaultExplorer WUX-C: in-place vault-page link navigation", () => {
  it("renders closed vault-page links as in-place controls and rejected forms as literal text", async () => {
    mockedRead.mockResolvedValue(NOTES_READ);
    await renderExplorer();
    await flush();
    const file = buttonWithLabel("Read file notes.md");
    await act(async () => file?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const vaultLinks = Array.from(container.querySelectorAll<HTMLButtonElement>(".markdown-vault-link"));
    expect(vaultLinks.map((b) => b.textContent)).toEqual(["Plan", "Zai log"]);
    // The external link keeps its existing safe new-tab anchor form.
    const external = container.querySelector<HTMLAnchorElement>("a.markdown-link[target='_blank']");
    expect(external?.getAttribute("href")).toBe("https://example.com/a");
    // A traversal target is never interactive and stays literal text.
    expect(container.textContent).toContain("[evil](../secret.md)");
  });

  it("navigates in place to the linked document via the existing bounded read route", async () => {
    mockedRead.mockResolvedValueOnce(NOTES_READ).mockResolvedValueOnce(PLAN_READ);
    await renderExplorer();
    await flush();
    const file = buttonWithLabel("Read file notes.md");
    await act(async () => file?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const planLink = container.querySelector<HTMLButtonElement>(".markdown-vault-link");
    await act(async () => planLink?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    // The existing bounded read route served the linked page; no new routes.
    expect(mockedRead).toHaveBeenLastCalledWith("Projects/Piren/plan.md", "T", expect.anything());
    // Document header shows the linked page name.
    expect(container.querySelector(".vault-explorer-document-name")?.textContent).toBe("plan.md");
    // The in-memory location/breadcrumb updated to the document's directory.
    expect(onLocationChange).toHaveBeenLastCalledWith({
      path: "Projects/Piren",
      document: { path: "Projects/Piren/plan.md", name: "plan.md" },
    });
    expect(Array.from(container.querySelectorAll(".vault-explorer-breadcrumb button")).map((b) => b.textContent)).toContain(
      "Piren",
    );
  });

  it("Back to listing after a link navigation lists the document's directory", async () => {
    mockedRead.mockResolvedValueOnce(NOTES_READ).mockResolvedValueOnce(PLAN_READ);
    await renderExplorer();
    await flush();
    const file = buttonWithLabel("Read file notes.md");
    await act(async () => file?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const planLink = container.querySelector<HTMLButtonElement>(".markdown-vault-link");
    await act(async () => planLink?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const back = buttonWithLabel("Back to listing");
    await act(async () => back?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    // The listing re-reads exactly the retained directory (root-relative).
    expect(mockedList).toHaveBeenLastCalledWith("Projects/Piren", "T", expect.anything());
  });
});
