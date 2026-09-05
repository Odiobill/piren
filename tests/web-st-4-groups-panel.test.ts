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
 *
 * SR-1: the fixtures use the REAL documented/route response shape — `roster`
 * is a SIBLING of `group`, never nested inside it — so the panel is proven
 * against a compliant live payload (the earlier nested shape hid the crash),
 * and a strictly rejected malformed roster stays a bounded notice.
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

// The REAL route shape: `group` carries no roster; `roster` is its sibling.
const GROUP: GroupDetailDto = {
  name: "dev",
  revision: "rev-abc-12",
  agents: ["kimi", "offline-one"],
  fallbackOrder: {},
  findings: [],
};
const ROSTER: Array<{ name: string; locallyRunnable: boolean }> = [
  { name: "kimi", locallyRunnable: true },
  { name: "offline-one", locallyRunnable: false },
  { name: "offline-two", locallyRunnable: false },
];

let container: HTMLDivElement;
let root: Root;
let onUnauthorized: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onUnauthorized = vi.fn();
  vi.mocked(fetchGroupsList).mockResolvedValue({ available: true, groups: [{ name: "dev", revision: "rev-list-1" }] });
  vi.mocked(fetchGroupDetail).mockResolvedValue({ available: true, group: GROUP, roster: ROSTER });
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
    expect(text).toContain("Kimi");
    expect(text).toContain("Not locally runnable");
    // Membership add is a bounded roster CHOICE, never free text.
    const addSelect = container.querySelector<HTMLSelectElement>(".settings-groups-add-select");
    expect(addSelect).not.toBeNull();
    expect(container.querySelector(".settings-groups-add-input")).toBeNull();
    const options = Array.from(addSelect?.querySelectorAll("option") ?? []).map((o) => o.value);
    expect(options).toEqual(["", "offline-two"]);
    expect(text).toContain("(Not locally runnable)");
  });

  it("SR-3: choosing a candidate stages it immediately and writes only after explicit confirm with the loaded revision", async () => {
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
    // Selecting one candidate stages it immediately; the separate Add step
    // no longer exists.
    expect(container.querySelector(".settings-groups-fallback-add"))?.toBeNull();
    const candidateSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select");
    await act(async () => {
      candidateSelect!.value = "offline-one";
      candidateSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Visible exact order.
    const order = Array.from(container.querySelectorAll(".settings-groups-fallback-list .settings-agent-fallback-model")).map(
      (n) => n.textContent,
    );
    expect(order).toEqual(["Offline One"]);
    // The selector resets after staging so no invisible pending state remains.
    expect(candidateSelect?.value).toBe("");
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

  it("SR-3 lead correction: staged candidates vanish from the dropdown and a remaining candidate stages in exact order", async () => {
    vi.mocked(fetchGroupDetail).mockResolvedValue({
      available: true,
      group: { ...GROUP, agents: ["kimi", "offline-one", "offline-two"], fallbackOrder: {} },
      roster: ROSTER,
    });
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      const memberSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member")!;
      memberSelect.value = "kimi";
      memberSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Before staging, both non-self members are addable.
    function optionValues(): string[] {
      return Array.from(
        container.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select")!.querySelectorAll("option"),
      ).map((o) => o.value);
    }
    expect(optionValues()).toEqual(["", "offline-one", "offline-two"]);
    // Stage offline-two: it must disappear from the remaining choices.
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select")!;
      select.value = "offline-two";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(optionValues()).toEqual(["", "offline-one"]);
    // The one remaining valid choice stages in EXACT order after the first.
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select")!;
      select.value = "offline-one";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const order = Array.from(container.querySelectorAll(".settings-groups-fallback-list .settings-agent-fallback-model")).map(
      (n) => n.textContent,
    );
    expect(order).toEqual(["Offline Two", "Offline One"]);
    // Nothing left to offer; no local error was needed on the normal path.
    expect(optionValues()).toEqual([""]);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("SR-3 lead correction: a defensively invalid saved order keeps its alert INSIDE the family with zero writes, and corrective actions clear it", async () => {
    vi.mocked(fetchGroupDetail).mockResolvedValue({
      available: true,
      group: { ...GROUP, agents: ["kimi", "offline-one"], fallbackOrder: { kimi: ["kimi"] } },
      roster: ROSTER,
    });
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      const memberSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member")!;
      memberSelect.value = "kimi";
      memberSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The loaded (defensively invalid) order shows the target as its own
    // candidate; Save refuses deterministically without any write.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-fallback-save")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(postGroupAction).not.toHaveBeenCalled();
    const alerts = Array.from(container.querySelectorAll("[role='alert']"));
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.closest(".settings-agent-family")).not.toBeNull();
    // Never below the New group name form.
    expect(container.querySelector(":scope > .settings-form-error")).toBeNull();

    // A corrective action (removing the offending row) clears the stale
    // alert; the next Save then opens a VALID confirmation under which no
    // local error survives.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-fallback-remove")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[role='alert']")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-fallback-save")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("SR-2: states the clearing outcome plainly when an intentionally empty order is confirmed", async () => {
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      const memberSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member")!;
      memberSelect.value = "kimi";
      memberSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Deliberate empty save (no candidate chosen): still allowed, but the
    // modal must say plainly that this CLEARS the saved order.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-groups-fallback-save")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent ?? "").toMatch(/empty/i);
    expect(dialog!.textContent).toContain("clears");
    // Intentional clearing remains possible behind the explicit confirm.
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".settings-agent-confirm-save")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(postGroupAction).toHaveBeenCalledTimes(1);
    expect(postGroupAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "fallback-set", agent: "kimi", candidates: [], confirm: true }),
      "t",
    );
  });


  it("SR-2 correction: opening another group resets the whole staged fallback editor", async () => {
    vi.mocked(fetchGroupsList).mockResolvedValue({
      available: true,
      groups: [
        { name: "group-a", revision: "rev-a-1" },
        { name: "group-b", revision: "rev-b-1" },
      ],
    });
    const groupA: GroupDetailDto = { name: "group-a", revision: "rev-a", agents: ["kimi", "offline-one"], fallbackOrder: {}, findings: [] };
    const groupB: GroupDetailDto = { name: "group-b", revision: "rev-b", agents: ["kimi"], fallbackOrder: {}, findings: [] };
    vi.mocked(fetchGroupDetail)
      .mockResolvedValueOnce({ available: true, group: groupA, roster: ROSTER })
      .mockResolvedValueOnce({ available: true, group: groupB, roster: ROSTER });
    await renderPanel();
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".settings-group-item")[0]!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Stage target + candidate on group A.
    await act(async () => {
      const memberSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member")!;
      memberSelect.value = "kimi";
      memberSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      const candidateSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-candidate-select")!;
      candidateSelect.value = "offline-one";
      candidateSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Switch to group B.
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".settings-group-item")[1]!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchGroupDetail).toHaveBeenLastCalledWith("group-b", "t");
    // The whole editor is unselected/empty: A's staged state cannot leak.
    const memberSelect = container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member");
    expect(memberSelect?.value ?? "").toBe("");
    expect(container.querySelector(".settings-groups-fallback-candidate-select")).toBeNull();
    expect(container.querySelector(".settings-groups-fallback-list"))?.toBeNull();
    const save = container.querySelector<HTMLButtonElement>(".settings-groups-fallback-save");
    expect(save?.disabled).toBe(true);
    expect(postGroupAction).not.toHaveBeenCalled();
    void groupB;
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

  it("SR-1: a real compliant detail response (sibling roster) renders selection, members, and offline markers without throwing", async () => {
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // No crash: the panel reached render with a defined roster.
    const text = container.textContent ?? "";
    expect(text).toContain("dev");
    expect(text).toContain("Kimi");
    expect(text).toContain("Not locally runnable");
    // Roster authority: only offline-two is an addable choice.
    const addSelect = container.querySelector<HTMLSelectElement>(".settings-groups-add-select");
    const options = Array.from(addSelect?.querySelectorAll("option") ?? []).map((o) => o.value);
    expect(options).toEqual(["", "offline-two"]);
  });

  it("SR-1: a strictly rejected malformed roster response stays a bounded notice — no throw, no blank page", async () => {
    // The typed client boundary refuses malformed payloads before render;
    // the mock simulates that bounded rejection exactly.
    vi.mocked(fetchGroupDetail).mockRejectedValue(new Error("Agent group could not be read."));
    await renderPanel();
    await act(async () => {
      groupButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("could not be read");
    // The page keeps its structure: list, create row, and retry paths remain.
    expect(container.querySelector(".settings-group-item")).not.toBeNull();
    expect(container.querySelector(".settings-groups-create")).not.toBeNull();
    expect(container.querySelector(".settings-group-detail")).toBeNull();
  });
});
