// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VaultExplorer } from "../web/src/VaultExplorer.js";
import { fetchVaultList, fetchVaultRead, UnauthorizedError } from "../web/src/api.js";
import type { VaultListResponse, VaultReadResponse } from "../web/src/vault-explorer.js";

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

const LIST: VaultListResponse = {
  path: ".",
  entries: [
    { name: "zeta.md", path: "zeta.md", type: "file", bytes: 12, mtimeMs: 3 },
    { name: "team", path: "team", type: "directory", mtimeMs: 5 },
    { name: "index.md", path: "index.md", type: "file", bytes: 8, mtimeMs: 1 },
  ],
  capped: false,
};

const TEAM_LIST: VaultListResponse = { path: "team", entries: [], capped: false };

const READ: VaultReadResponse = {
  path: "index.md",
  content: "# Title\n\nHello vault.",
  bytes: 30,
  mtimeMs: 1,
  capped: false,
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderExplorer(overrides: { token?: string } = {}): Promise<{ onUnauthorized: ReturnType<typeof vi.fn>; onValidated: ReturnType<typeof vi.fn> }> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onUnauthorized = vi.fn();
  const onValidated = vi.fn();
  await act(async () => {
    root.render(createElement(VaultExplorer, { token: overrides.token ?? "T", onUnauthorized, onValidated }));
  });
  return { onUnauthorized, onValidated };
}

function button(label: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((b) => b.getAttribute("aria-label")?.includes(label) || b.textContent?.includes(label)) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("VaultExplorer: load / render / navigate", () => {
  it("loads the bounded root listing on mount with the in-memory token and validates auth", async () => {
    mockedList.mockResolvedValue(LIST);
    const { onValidated } = await renderExplorer();
    expect(mockedList).toHaveBeenCalledWith(".", "T", expect.anything());
    await flush();
    expect(onValidated).toHaveBeenCalled();
    // Dirs first then files (alpha within each): team, index.md, zeta.md.
    const rows = Array.from(container.querySelectorAll(".vault-explorer-entry"));
    const names = rows.map((r) => r.querySelectorAll("span")[1]?.textContent);
    expect(names).toEqual(["team", "index.md", "zeta.md"]);
    // V2: decorative icons replaced the textual dir/file type labels.
    expect(rows[0]?.querySelector(".vault-entry-icon svg")).not.toBeNull();
    expect(container.querySelector(".vault-entry-type")).toBeNull();
    // Accessible action/name labels are retained.
    expect(rows[0]?.getAttribute("aria-label")).toBe("Open directory team");
    expect(rows[1]?.getAttribute("aria-label")).toBe("Read file index.md");
  });

  it("navigates into a directory via an explicit click (fresh server listing)", async () => {
    mockedList.mockResolvedValueOnce(LIST).mockResolvedValueOnce(TEAM_LIST);
    await renderExplorer();
    await flush();
    const teamButton = button("team");
    expect(teamButton).not.toBeNull();
    await act(async () => teamButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockedList).toHaveBeenLastCalledWith("team", "T", expect.anything());
    expect(container.textContent).toContain("Empty directory.");
  });

  it("selects a file and renders it through the existing safe Markdown renderer", async () => {
    mockedList.mockResolvedValue(LIST);
    mockedRead.mockResolvedValue(READ);
    await renderExplorer();
    await flush();
    const fileButton = button("index.md");
    await act(async () => fileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockedRead).toHaveBeenCalledWith("index.md", "T", expect.anything());
    expect(container.querySelector(".markdown-body")).not.toBeNull();
    expect(container.textContent).toContain("Hello vault.");
  });

  it("shows a bounded capped notice when the server caps the listing", async () => {
    mockedList.mockResolvedValue({ path: ".", entries: LIST.entries, capped: true });
    await renderExplorer();
    await flush();
    expect(container.textContent).toContain("capped");
  });

  it("shows a bounded truncated notice for a capped file read", async () => {
    mockedList.mockResolvedValue(LIST);
    mockedRead.mockResolvedValue({ ...READ, capped: true });
    await renderExplorer();
    await flush();
    await act(async () => button("index.md")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.textContent).toMatch(/truncated/i);
  });
});

describe("VaultExplorer: fail-closed error behavior", () => {
  it("surfaces 401 through onUnauthorized (never an error dump)", async () => {
    mockedList.mockRejectedValue(new UnauthorizedError());
    const { onUnauthorized } = await renderExplorer();
    await flush();
    expect(onUnauthorized).toHaveBeenCalled();
    expect(container.textContent).not.toContain("token");
  });

  it("renders a bounded non-401 list error with an explicit Retry (no hidden retry)", async () => {
    mockedList.mockRejectedValueOnce(new Error("vault list HTTP 500"));
    await renderExplorer();
    await flush();
    expect(container.textContent).toContain("listing failed");
    expect(container.textContent).not.toContain("vault list HTTP 500");
    mockedList.mockResolvedValueOnce(LIST);
    const retry = button("Retry");
    expect(retry).not.toBeNull();
    await act(async () => retry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".vault-explorer-entry")).not.toBeNull();
  });

  it("shows a bounded read error and never dumps the raw error", async () => {
    mockedList.mockResolvedValue(LIST);
    mockedRead.mockRejectedValueOnce(new Error("vault read HTTP 403"));
    await renderExplorer();
    await flush();
    await act(async () => button("index.md")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.textContent).toContain("could not be read");
    expect(container.textContent).not.toContain("vault read HTTP 403");
  });
});

describe("VaultExplorer: safe render and no fetch on display-only transitions", () => {
  it("renders document content as text — never raw HTML", async () => {
    mockedList.mockResolvedValue(LIST);
    mockedRead.mockResolvedValue({ ...READ, content: "<script>alert(1)</script>\n\n**bold** text" });
    await renderExplorer();
    await flush();
    await act(async () => button("index.md")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[data-dangerously-set-inner-html]")).toBeNull();
    // The raw script text renders literally; the markdown emphasis is parsed.
    expect(container.textContent).toContain("alert(1)");
    expect(container.textContent).toContain("bold text");
  });

  it("does not refetch on a display-only re-render with identical props", async () => {
    mockedList.mockResolvedValue(LIST);
    const onUnauthorized = vi.fn();
    const onValidated = vi.fn();
    await act(async () => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      root.render(createElement(VaultExplorer, { token: "T", onUnauthorized, onValidated }));
    });
    await flush();
    expect(mockedList).toHaveBeenCalledTimes(1);
    // Identical props (same stable callbacks): the component stays mounted and
    // does not refetch — a display-only re-render must not trigger a read.
    await act(async () => {
      root.render(createElement(VaultExplorer, { token: "T", onUnauthorized, onValidated }));
    });
    await flush();
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// V2 — document and listing presentation polish.
// ---------------------------------------------------------------------------

describe("VaultExplorer presentation polish (V2)", () => {
  it("keeps other entries disabled with an icon and an accessible label", async () => {
    const list: VaultListResponse = {
      path: ".",
      entries: [
        { name: "socket.sock", path: "socket.sock", type: "other", mtimeMs: 2 },
        { name: "team", path: "team", type: "directory", mtimeMs: 5 },
      ],
      capped: false,
    };
    mockedList.mockResolvedValue(list);
    await renderExplorer();
    await flush();
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".vault-explorer-entry"));
    const otherRow = rows.find((r) => r.getAttribute("aria-label") === "Read file socket.sock");
    expect(otherRow).toBeDefined();
    expect(otherRow?.disabled).toBe(true);
    expect(otherRow?.querySelector(".vault-entry-icon svg")).not.toBeNull();
  });

  it("renders non-Markdown files as literal bounded text — never as markup", async () => {
    mockedList.mockResolvedValue({
      path: ".",
      entries: [{ name: "notes.txt", path: "notes.txt", type: "file", bytes: 40, mtimeMs: 1 }],
      capped: false,
    });
    mockedRead.mockResolvedValue({
      path: "notes.txt",
      content: "# Not a heading\n\n**this is not bold** <b>nor html</b>\n---\ndashes stay literal",
      bytes: 90,
      mtimeMs: 1,
      capped: false,
    });
    await renderExplorer();
    await flush();
    const entry = button("notes.txt");
    await act(async () => entry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const literal = container.querySelector(".vault-explorer-literal");
    expect(literal).not.toBeNull();
    expect(literal?.textContent).toContain("# Not a heading");
    expect(literal?.textContent).toContain("**this is not bold**");
    expect(literal?.textContent).toContain("<b>nor html</b>");
    expect(literal?.textContent).toContain("---");
    expect(container.querySelector(".markdown-body")).toBeNull();
    expect(container.querySelector(".vault-explorer-frontmatter")).toBeNull();
  });

  it("renders valid Markdown frontmatter as a separate metadata card with only the body passed to the renderer", async () => {
    mockedList.mockResolvedValue({
      path: ".",
      entries: [{ name: "meta.md", path: "meta.md", type: "file", bytes: 80, mtimeMs: 1 }],
      capped: false,
    });
    mockedRead.mockResolvedValue({
      path: "meta.md",
      content: "---\ntitle: Hello Vault\ntags:\n  - piren\n  - workbench\n---\n# Body heading\n\nBody text.",
      bytes: 120,
      mtimeMs: 1,
      capped: false,
    });
    await renderExplorer();
    await flush();
    const entry = button("meta.md");
    await act(async () => entry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const card = container.querySelector(".vault-explorer-frontmatter");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("title");
    expect(card?.textContent).toContain("Hello Vault");
    expect(card?.textContent).toContain("piren, workbench");
    const body = container.querySelector(".markdown-body");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("Body heading");
    // The frontmatter block itself is not part of the rendered body.
    expect(body?.textContent).not.toContain("Hello Vault");
    // The card is outside the markdown body element.
    expect(card?.contains(body ?? null)).toBe(false);
  });

  it("fails quiet to whole-file safe Markdown on malformed frontmatter", async () => {
    mockedList.mockResolvedValue({
      path: ".",
      entries: [{ name: "broken.md", path: "broken.md", type: "file", bytes: 60, mtimeMs: 1 }],
      capped: false,
    });
    mockedRead.mockResolvedValue({
      path: "broken.md",
      content: "---\ntitle: x\nno colon line\n---\n# Still rendered",
      bytes: 80,
      mtimeMs: 1,
      capped: false,
    });
    await renderExplorer();
    await flush();
    const entry = button("broken.md");
    await act(async () => entry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector(".vault-explorer-frontmatter")).toBeNull();
    const body = container.querySelector(".markdown-body");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("Still rendered");
  });

  it("gates Markdown rendering case-insensitively on the filename", async () => {
    mockedList.mockResolvedValue({
      path: ".",
      entries: [{ name: "README.MD", path: "README.MD", type: "file", bytes: 20, mtimeMs: 1 }],
      capped: false,
    });
    mockedRead.mockResolvedValue({
      path: "README.MD",
      content: "# Uppercase",
      bytes: 12,
      mtimeMs: 1,
      capped: false,
    });
    await renderExplorer();
    await flush();
    const entry = button("README.MD");
    await act(async () => entry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector(".vault-explorer-literal")).toBeNull();
    expect(container.querySelector(".markdown-body")?.textContent).toContain("Uppercase");
  });
});

describe("VaultExplorer presentation continuity (WUX-B)", () => {
  async function renderWithLocation(
    location: import("../web/src/vault-explorer.js").VaultExplorerLocation | undefined,
    onLocationChange?: (l: import("../web/src/vault-explorer.js").VaultExplorerLocation) => void,
  ): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(VaultExplorer, {
          token: "T",
          onUnauthorized: vi.fn(),
          onValidated: vi.fn(),
          ...(location !== undefined ? { initialLocation: location } : {}),
          ...(onLocationChange !== undefined ? { onLocationChange } : {}),
        }),
      );
    });
    await flush();
  }

  it("a lifted nested directory/document location survives a remount: fresh reread of the SAME paths, never the root", async () => {
    mockedList.mockResolvedValue(TEAM_LIST);
    mockedRead.mockResolvedValue({ ...READ, path: "team/dipu/notes.md" });
    await renderWithLocation({
      path: "team/dipu",
      document: { path: "team/dipu/notes.md", name: "notes.md" },
    });
    // The fresh bounded rereads target the retained location, not the root.
    expect(mockedList).toHaveBeenCalledWith("team/dipu", "T", expect.anything());
    expect(mockedList).not.toHaveBeenCalledWith(".", "T", expect.anything());
    expect(mockedRead).toHaveBeenCalledWith("team/dipu/notes.md", "T", expect.anything());
    // The retained document renders.
    expect(container.textContent).toContain("notes.md");
  });

  it("navigation reports the new location through onLocationChange (directory, then document)", async () => {
    mockedList.mockResolvedValue(LIST);
    const reported: Array<{ path: string; document: { path: string; name: string } | null }> = [];
    await renderWithLocation(undefined, (l) => reported.push(l as { path: string; document: { path: string; name: string } | null }));
    expect(reported.length).toBe(0);

    // Open a directory.
    const teamEntry = button("Open directory team");
    expect(teamEntry).not.toBeNull();
    mockedList.mockResolvedValue({
      path: "team",
      entries: [{ name: "notes.md", path: "team/notes.md", type: "file", bytes: 9, mtimeMs: 4 }],
      capped: false,
    });
    await act(async () => teamEntry?.click());
    await flush();
    expect(reported.at(-1)).toEqual({ path: "team", document: null });

    // Select a document within it.
    mockedRead.mockResolvedValue({ ...READ, path: "team/notes.md" });
    const notesEntry = button("Read file notes.md");
    expect(notesEntry).not.toBeNull();
    await act(async () => notesEntry?.click());
    await flush();
    expect(mockedRead).toHaveBeenCalledWith("team/notes.md", "T", expect.anything());
    expect(reported.at(-1)).toEqual({ path: "team", document: { path: "team/notes.md", name: "notes.md" } });

    // Returning to the listing clears the retained document.
    const back = container.querySelector<HTMLButtonElement>(".vault-explorer-back");
    await act(async () => back?.click());
    await flush();
    expect(reported.at(-1)).toEqual({ path: "team", document: null });
  });
});

describe("VaultExplorer ordering control (WUX-B)", () => {
  async function renderWithOrdering(ordering?: "name" | "recent", onOrderingChange?: (o: "name" | "recent") => void): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(VaultExplorer, {
          token: "T",
          onUnauthorized: vi.fn(),
          onValidated: vi.fn(),
          ...(ordering !== undefined ? { ordering } : {}),
          ...(onOrderingChange !== undefined ? { onOrderingChange } : {}),
        }),
      );
    });
    await flush();
  }

  function orderToggle(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(".vault-explorer-order-toggle");
    if (el === null) throw new Error("order toggle missing");
    return el;
  }

  it("renders one concise icon-bearing header toggle with a current-order indication, default Name", async () => {
    mockedList.mockResolvedValue(LIST);
    await renderWithOrdering();
    const toggle = orderToggle();
    expect(toggle.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toContain("Name");
    // The initial request carries no ordering parameter (default compatible).
    expect(mockedList).toHaveBeenCalledWith(".", "T", expect.anything());
  });

  it("toggling to Recent reports the closed value, requests the SAME directory with recent ordering, and re-asserts recency rendering", async () => {
    mockedList.mockResolvedValue(LIST);
    const orders: Array<"name" | "recent"> = [];
    await renderWithOrdering(undefined, (o) => orders.push(o));

    // The server response arrives in an arbitrary order; the explorer
    // re-asserts mtime-descending presentation for Recent.
    mockedList.mockResolvedValue(LIST);
    await act(async () => orderToggle().click());
    await flush();
    expect(orders).toEqual(["recent"]);
    expect(mockedList).toHaveBeenLastCalledWith(".", "T", expect.anything(), "recent");
    expect(orderToggle().getAttribute("aria-pressed")).toBe("true");
    expect(orderToggle().textContent).toContain("Recent");
    const presentedNames = Array.from(
      container.querySelectorAll<HTMLSpanElement>(".vault-explorer-entries li > button > span:nth-child(2)"),
    ).map((el) => el.textContent);
    // LIST fixture mtimes: team=5, zeta.md=3, index.md=1 -> recency order.
    expect(presentedNames).toEqual(["team", "zeta.md", "index.md"]);
    // No document/listing reset happened: still the same directory.
    expect(container.textContent).not.toContain("Back to listing");
  });

  it("lifted ordering survives a remount and is sent on the fresh reread", async () => {
    mockedList.mockResolvedValue(LIST);
    await renderWithOrdering("recent");
    expect(mockedList).toHaveBeenCalledWith(".", "T", expect.anything(), "recent");
  });
});
