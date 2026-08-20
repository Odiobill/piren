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
    expect(rows[0]?.querySelector(".vault-entry-type")?.textContent).toBe("dir");
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
