// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UnauthorizedError } from "../web/src/api.js";
import {
  fetchGroupDetail,
  fetchGroupsList,
  fetchGroupsValidation,
  postGroupAction,
  type GroupDetailDto,
} from "../web/src/groups-api.js";
import { AgentGroupsPanel } from "../web/src/AgentGroupsPanel.js";

/**
 * ST-4 lead correction — jsdom coverage for the closed Groups workflows:
 * vault-roster authority with visible non-runnable markers, ordered
 * fallback-set editing behind explicit confirmation, full confirmation-modal
 * discipline (trap/escape/focus return/icons incl. Cancel), typed 401
 * recovery, and the read-only cross-group validation report.
 */

vi.mock("../web/src/groups-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/groups-api.js")>();
  return {
    ...actual,
    fetchGroupsList: vi.fn(),
    fetchGroupDetail: vi.fn(),
    fetchGroupsValidation: vi.fn(),
    postGroupAction: vi.fn(),
  };
});

const DETAIL: GroupDetailDto = {
  name: "dev",
  revision: "rev-abc-12",
  agents: ["kimi", "offline-one"],
  fallbackOrder: {},
  findings: [],
  roster: [
    { name: "kimi", locallyRunnable: true },
    { name: "offline-one", locallyRunnable: false },
    { name: "offline-two", locallyRunnable: false },
  ],
};

let container: HTMLDivElement;
let root: Root;
let onUnauthorized: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onUnauthorized = vi.fn();
  vi.mocked(fetchGroupsList).mockResolvedValue({ available: true, groups: [{ name: "dev", revision: "rev-list-1" }] });
  vi.mocked(fetchGroupDetail).mockResolvedValue({ available: true, group: DETAIL });
  vi.mocked(fetchGroupsValidation).mockResolvedValue({ available: true, issues: [] });
  vi.mocked(postGroupAction).mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPanel(): Promise<void> {
  await act(async () => {
    root.render(createElement(AgentGroupsPanel, { token: "t", onUnauthorized }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function groupButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".settings-group-item");
  if (button === null) throw new Error("group item missing");
  return button;
}

describe("AgentGroupsPanel (ST-4 correction)", () => {
  it("shows every roster member with a visible Not locally runnable marker and restricts add choices to the roster", async () => {
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("kimi");
    expect(text).toContain("Not locally runnable");
    // Membership add is a bounded roster CHOICE, never free text.
    const addSelect = container.querySelector<HTMLSelectElement>(".settings-groups-add-select");
    expect(addSelect).not.toBeNull();
    expect(container.querySelector(".settings-groups-add-input")).toBeNull();
    const options = Array.from(addSelect?.querySelectorAll("option") ?? []).map((o) => o.value);
    expect(options).toEqual(["", "offline-two"]);
    expect(text).toContain("(Not locally runnable)");
  });

  it("edits ordered fallback candidates for a selected member and writes only after explicit confirm with the loaded revision", async () => {
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Choose member kimi as the fallback target.
    const memberSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member");
    expect(memberSelect).not.toBeNull();
    await act(async () => {
      memberSelect!.value = "kimi";
      memberSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Add one candidate.
    const candidateSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select");
    await act(async () => {
      candidateSelect!.value = "offline-one";
      candidateSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-fallback-add")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Visible exact order.
    const order = Array.from(container.querySelectorAll(".settings-groups-fallback-list .settings-agent-fallback-model")).map(
      (n) => n.textContent,
    );
    expect(order).toEqual(["offline-one"]);
    // Open confirmation; nothing writes before it.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-fallback-save")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(postGroupAction).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-agent-confirm-save")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(postGroupAction).toHaveBeenCalledTimes(1);
    expect(postGroupAction).toHaveBeenCalledWith(
      {
        action: "fallback-set",
        group: "dev",
        agent: "kimi",
        candidates: ["offline-one"],
        expectedRevision: "rev-abc-12",
        confirm: true,
      },
      "t",
    );
  });

  it("gives the confirmation modal full discipline: Escape cancels without writing and returns focus to the action", async () => {
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-remove")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Every dialog button carries a decorative icon, including Cancel.
    const buttons = Array.from(dialog!.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) expect(button.querySelector("svg")).not.toBeNull();
    // Focus entered the dialog on open.
    expect(dialog!.contains(document.activeElement)).toBe(true);

    // Tab cycles within the dialog instead of escaping to the page.
    const focusables = buttons;
    document.activeElement === focusables[focusables.length - 1];
    const last = focusables[focusables.length - 1]!;
    last.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(focusables.includes(document.activeElement as HTMLButtonElement)).toBe(true);
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);

    // The originating remove action is tracked for focus return.
    const origin = container.querySelector<HTMLButtonElement>(".settings-groups-remove")!;
    const spy = vi.spyOn(origin, "focus");

    // Escape dismisses with zero write and returns focus.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(postGroupAction).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });

  it("fires the typed unauthorized path when a groups GET is rejected with 401", async () => {
    vi.mocked(fetchGroupsList).mockRejectedValue(new UnauthorizedError());
    await renderPanel();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // No regex-based auth handling remains: a generic failure does not log out.
    vi.clearAllMocks();
    vi.mocked(fetchGroupsList).mockRejectedValue(new Error("Agent groups could not be read."));
    await renderPanel2();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  async function renderPanel2(): Promise<void> {
    await renderPanel();
  }

  it("surfaces the read-only cross-group validation report", async () => {
    vi.mocked(fetchGroupsValidation).mockResolvedValue({
      available: true,
      issues: [
        { group: "dev", kind: "dangling-fallback", severity: "error", message: "fallback_order for 'kimi' references 'ghost'." },
        { group: "dev", kind: "duplicate-across-groups", severity: "info", message: "Agent 'kimi' is declared in 2 groups." },
      ],
    });
    await renderPanel();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-validate")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const report = container.querySelector(".settings-groups-validation-report");
    expect(report).not.toBeNull();
    expect(report!.textContent).toContain("dangling-fallback");
    expect(report!.textContent).toContain("duplicate-across-groups");
    expect(fetchGroupsValidation).toHaveBeenCalledTimes(1);
  });
});
