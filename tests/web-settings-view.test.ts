// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsView } from "../web/src/SettingsView.js";
import { Sidebar } from "../web/src/Sidebar.js";
import { fetchConversations } from "../web/src/api.js";

/**
 * W3 (0.2.0 amendment §5) — jsdom tests for the static full-page Settings
 * shell: accessible semantic structure, non-action language, and zero
 * interactive/config surface; plus the Sidebar Settings nav item contract
 * (aria-current, selection, drawer-close convention preserved by the shell).
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversations: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SettingsView (W3 static shell)", () => {
  it("renders an accessible page heading and tier sections", () => {
    act(() => root.render(createElement(SettingsView)));
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Settings");
    const sections = container.querySelectorAll("section[aria-labelledby]");
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const headings = [...container.querySelectorAll("section h3")].map((h) => h.textContent ?? "");
    expect(headings.some((h) => /typed configuration workflows/i.test(h))).toBe(true);
    expect(headings.some((h) => /read-only inspection/i.test(h))).toBe(true);
    expect(headings.some((h) => /service actions/i.test(h))).toBe(true);
  });

  it("names the Tier A workflow families and accurately labels delivered model fallback", () => {
    act(() => root.render(createElement(SettingsView)));
    const text = container.textContent ?? "";
    expect(text).toContain("Telegram");
    expect(text).toContain("Discord");
    expect(text).toContain("Scheduler");
    expect(text).toMatch(/model preference/i);
    expect(text).toMatch(/same agent/i);
    expect(text).toMatch(/same live session|same session/i);
    expect(text).not.toMatch(/inert groundwork/i);
  });

  it("makes clear nothing is read or changed yet, with non-action language", () => {
    act(() => root.render(createElement(SettingsView)));
    const text = container.textContent ?? "";
    expect(text).toMatch(/nothing on this page reads or changes/i);
    expect(text).toMatch(/not available in this shell/i);
    expect(text).toMatch(/separately gated/i);
  });

  it("has zero interactive or configuration surface: no inputs, forms, buttons, selects, or textareas", () => {
    act(() => root.render(createElement(SettingsView)));
    expect(container.querySelectorAll("input, textarea, select, form, button")).toHaveLength(0);
  });

  it("lists the boundaries Settings will never cross", () => {
    act(() => root.render(createElement(SettingsView)));
    const text = container.textContent ?? "";
    expect(text).toMatch(/never/i);
    expect(text).toMatch(/generic/i);
    expect(text).toMatch(/provider credential/i);
  });
});

describe("Sidebar Settings nav item (W3)", () => {
  beforeEach(() => {
    vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
  });

  it("renders a Settings nav item with aria-current only when selected", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        createElement(Sidebar, {
          page: "settings",
          token: "t",
          onSelect,
          onValidated: () => {},
          onUnauthorized: () => {},
          conversationsReloadKey: 0,
          explorerOpen: false,
          onToggleExplorer: () => {},
        }),
      );
    });
    const buttons = [...container.querySelectorAll("button")];
    const settingsButton = buttons.find((b) => b.textContent === "Settings");
    expect(settingsButton).toBeDefined();
    expect(settingsButton?.getAttribute("aria-current")).toBe("page");
    const dashboardButton = buttons.find((b) => b.textContent === "Dashboard");
    expect(dashboardButton?.getAttribute("aria-current")).toBeNull();
  });

  it("selecting Settings calls onSelect('settings')", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        createElement(Sidebar, {
          page: "dashboard",
          token: "t",
          onSelect,
          onValidated: () => {},
          onUnauthorized: () => {},
          conversationsReloadKey: 0,
          explorerOpen: false,
          onToggleExplorer: () => {},
        }),
      );
    });
    const settingsButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Settings");
    expect(settingsButton).toBeDefined();
    await act(async () => {
      settingsButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("settings");
  });
});
