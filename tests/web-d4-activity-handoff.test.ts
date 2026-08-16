// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import {
  abortConversationRun,
  approveConversationApproval,
  attachConversation,
  fetchConversation,
  fetchConversationAgents,
} from "../web/src/api.js";

/**
 * D4 — Conversation activity tray row + recognized handoff approval
 * presentation (accepted `workbench-dashboard-refinement-plan.md`
 * Conversation presentation decisions 4–6).
 *
 * 1. The compact broker-authoritative live activity/abort rendering is one
 *    named sibling row in the interaction tray ABOVE the composer controls
 *    (and after any approval surface) — never inside .composer-action-row,
 *    so the composer keeps its flex width. Content, abort semantics, and
 *    cleanup are unchanged; no animation was added (pinned).
 * 2. A card recognized solely by the existing parseConversationHandoffGate
 *    gets modest top separation, a distinct non-error tint, and decorative
 *    Confirm/Cancel icons; generic approvals are byte-identical. Approval
 *    authority, pager, focus, and route semantics are unchanged.
 */

const CONVERSATION = {
  id: "c1",
  title: "Conversation with dipu",
  audience: ["dipu"],
  status: "open",
  path: "collaboration/conversations/c1/index.md",
  createdBy: "steward",
  created: "2026-08-15T13:00:00.000Z",
  updated: "2026-08-15T13:00:00.000Z",
};

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchConversation: vi.fn(),
    attachConversation: vi.fn(),
    approveConversationApproval: vi.fn(),
    abortConversationRun: vi.fn(),
  };
});

let timelineProps: Record<string, unknown> = {};
vi.mock("../web/src/ConversationTimeline.js", () => ({
  ConversationTimeline: (props: Record<string, unknown>) => {
    timelineProps = props;
    return createElement("div", { className: "mock-timeline" });
  },
}));
vi.mock("../web/src/ConversationComposer.js", () => ({
  ConversationComposer: () => createElement("div", { className: "mock-composer" }),
}));
vi.mock("../web/src/ConversationDetailsModal.js", () => ({
  ConversationDetailsModal: () => null,
  ConversationLifecycleControls: () => null,
}));

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deliverActivity(runs: Array<{ runId: string; agent: string; phase: "working" | "typing" }>): void {
  const onActivityChange = timelineProps.onActivityChange as ((runs: unknown) => void) | undefined;
  if (onActivityChange === undefined) throw new Error("onActivityChange not wired");
  onActivityChange(runs);
}

function deliverApproval(approval: { requestId: string; agent?: string; method?: string; payload?: Record<string, unknown> }): void {
  const onApproval = timelineProps.onApproval as (approval: unknown) => void;
  onApproval({
    conversationId: "c1",
    agent: approval.agent ?? "dipu",
    requestId: approval.requestId,
    method: approval.method ?? "confirm",
    payload: approval.payload ?? { title: "Proceed?" },
  });
}

function activityRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-activity-row");
}

function trayChildOrder(): string[] {
  const tray = container.querySelector<HTMLElement>(".interaction-tray");
  if (tray === null) return [];
  return Array.from(tray.children).map((child) => child.className.split(" ")[0] ?? "");
}

beforeEach(() => {
  // jsdom does not implement Element.scrollTo; the navigator's scroll-anchor
  // layout effect calls it when activity changes bump the content version.
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }, { name: "zai", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation)
    .mockReset()
    .mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
  vi.mocked(approveConversationApproval).mockReset().mockResolvedValue(undefined);
  vi.mocked(abortConversationRun).mockReset().mockResolvedValue({ status: "cancelled" });
  container = document.createElement("div");
  document.body.append(container);
  window.location.hash = "#conversation/c1";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  window.location.hash = "";
});

async function mountNavigator(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ConversationNavigator, {
        token: "t",
        onUnauthorized: () => {},
        onValidated: () => {},
        onConversationsChanged: () => {},
      }),
    );
  });
  await flush();
}

describe("D4 live activity tray row", () => {
  it("renders active runs in one named tray sibling row above composer controls, never inside the composer row", async () => {
    await mountNavigator();
    await act(async () => deliverApproval({ requestId: "req-1" }));
    await act(async () =>
      deliverActivity([
        { runId: "r1", agent: "dipu", phase: "working" },
        { runId: "r2", agent: "zai", phase: "typing" },
      ]),
    );
    await flush();

    const row = activityRow();
    expect(row).not.toBeNull();
    // A direct named sibling row of the interaction tray.
    expect(row?.parentElement?.classList.contains("interaction-tray")).toBe(true);
    // Never inside the horizontal composer action row (old placement gone).
    expect(container.querySelector(".composer-action-row .conversation-activity-row")).toBeNull();
    expect(container.querySelector(".composer-action-row .dock-run-status")).toBeNull();
    // Exactly one named row for all runs.
    expect(container.querySelectorAll(".conversation-activity-row")).toHaveLength(1);
    // Order: approval surface, then the activity row, then composer controls.
    expect(trayChildOrder()).toEqual(["approval-cards", "conversation-activity-row", "composer-action-row"]);
    // The composer keeps its place inside the composer action row.
    expect(container.querySelector(".composer-action-row .mock-composer")).not.toBeNull();
    // Exact compact source fields: broker-provided agent + truthful phase.
    expect(row?.textContent).toContain("dipu");
    expect(row?.textContent).toContain("is working…");
    expect(row?.textContent).toContain("zai");
    expect(row?.textContent).toContain("is typing…");
    // The exact agent-scoped abort affordance is preserved.
    expect(row?.querySelector('[aria-label="Abort dipu run"]')).not.toBeNull();
    expect(row?.querySelector('[aria-label="Abort zai run"]')).not.toBeNull();
  });

  it("keeps the exact abort busy/error/manual-retry semantics in the tray row", async () => {
    let release: (() => void) | undefined;
    vi.mocked(abortConversationRun).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "cancelled" });
        }),
    );
    await mountNavigator();
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    const abort = activityRow()?.querySelector<HTMLButtonElement>('[aria-label="Abort dipu run"]');
    expect(abort).toBeDefined();
    act(() => {
      abort?.click();
    });
    expect(vi.mocked(abortConversationRun)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(activityRow()?.querySelector<HTMLButtonElement>('[aria-label="Abort dipu run"]')?.disabled).toBe(true);
    await act(async () => {
      release?.();
    });
    await flush();

    // Error path: bounded visible error; retry is only an explicit fresh click.
    vi.mocked(abortConversationRun).mockRejectedValueOnce(new Error("abort HTTP 500"));
    await act(async () => {
      activityRow()?.querySelector<HTMLButtonElement>('[aria-label="Abort dipu run"]')?.click();
    });
    await flush();
    const error = activityRow()?.querySelector("[role='alert']");
    expect(error?.textContent).toContain("abort HTTP 500");
    expect(vi.mocked(abortConversationRun)).toHaveBeenCalledTimes(2);
  });

  it("renders no activity row with no runs, after cleanup, and never on read-only inspection", async () => {
    await mountNavigator();
    await flush();
    expect(activityRow()).toBeNull();

    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    expect(activityRow()).not.toBeNull();

    // Every fail-closed cleanup path reports an empty run list; the row
    // disappears with it (no settled summary, no partial text).
    await act(async () => deliverActivity([]));
    await flush();
    expect(activityRow()).toBeNull();
    expect(container.textContent).not.toContain("is working");
  });

  it("read-only inspection has no activity row and no activity wiring", async () => {
    vi.mocked(attachConversation).mockResolvedValue({
      attached: false,
      error: "agent 'dipu' is not runnable",
      gate: { ok: false, missing: ["dipu"], malformed: [] },
    });
    await mountNavigator();
    await flush();
    expect(container.querySelector(".attach-banner")).not.toBeNull();
    expect(container.querySelector(".interaction-tray")).toBeNull();
    expect(activityRow()).toBeNull();
    expect(timelineProps.onActivityChange).toBeUndefined();
  });
});

describe("D4 recognized handoff approval presentation", () => {
  function confirmButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".approval-card button")).find(
      (candidate) => candidate.textContent === "Confirm",
    );
    if (button === undefined) throw new Error("Confirm button missing");
    return button;
  }

  function cancelButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".approval-card button")).find(
      (candidate) => candidate.textContent === "Cancel",
    );
    if (button === undefined) throw new Error("Cancel button missing");
    return button;
  }

  it("a recognized handoff gate gets the modest distinct class and decorative Confirm/Cancel icons", async () => {
    await mountNavigator();
    await act(async () =>
      deliverApproval({ requestId: "req-h", payload: { to: "zai", text: "Please continue this task." } }),
    );
    await flush();
    const card = container.querySelector<HTMLElement>(".approval-card");
    expect(card?.classList.contains("approval-card-handoff")).toBe(true);
    // Recognition/title/meta semantics unchanged.
    expect(card?.getAttribute("aria-label")).toBe("Handoff request: handoff from dipu to zai");
    expect(card?.querySelector(".approval-title")?.textContent).toBe("Handoff request");
    // Decorative icons on the text-labelled actions: svg present, aria-hidden,
    // visible accessible text retained.
    const confirm = confirmButton();
    const confirmIcon = confirm.querySelector("svg");
    expect(confirmIcon).not.toBeNull();
    expect(confirmIcon?.getAttribute("aria-hidden")).toBe("true");
    expect(confirm.textContent).toBe("Confirm");
    const cancel = cancelButton();
    const cancelIcon = cancel.querySelector("svg");
    expect(cancelIcon).not.toBeNull();
    expect(cancelIcon?.getAttribute("aria-hidden")).toBe("true");
    expect(cancel.textContent).toBe("Cancel");
    // Focus-on-arrival is unchanged (Confirm focused for a confirm-method card).
    expect(document.activeElement).toBe(confirm);
  });

  it("generic approvals keep their exact current presentation (no handoff class, no icons)", async () => {
    await mountNavigator();
    await act(async () => deliverApproval({ requestId: "req-g" }));
    await flush();
    const card = container.querySelector<HTMLElement>(".approval-card");
    expect(card?.classList.contains("approval-card-handoff")).toBe(false);
    expect(card?.getAttribute("aria-label")).toBe("Approval requested by dipu");
    const confirm = confirmButton();
    expect(confirm.querySelector("svg")).toBeNull();
    expect(confirm.textContent).toBe("Confirm");
    expect(cancelButton().querySelector("svg")).toBeNull();
  });

  it("an unrecognized/malformed frame keeps the generic card (no handoff presentation)", async () => {
    await mountNavigator();
    await act(async () => deliverApproval({ requestId: "req-m", payload: { title: "Proceed?" } }));
    await flush();
    const card = container.querySelector<HTMLElement>(".approval-card");
    expect(card?.classList.contains("approval-card-handoff")).toBe(false);
    expect(confirmButton().querySelector("svg")).toBeNull();
  });

  it("handoff Confirm/Cancel authority and route bodies are unchanged", async () => {
    await mountNavigator();
    await act(async () =>
      deliverApproval({ requestId: "req-h", payload: { to: "zai", text: "Please continue this task." } }),
    );
    await flush();
    await act(async () => {
      confirmButton().click();
    });
    expect(vi.mocked(approveConversationApproval)).toHaveBeenCalledWith("c1", "dipu", "req-h", { confirmed: true }, "t");

    await act(async () =>
      deliverApproval({ requestId: "req-h2", payload: { to: "zai", text: "Another gate." } }),
    );
    await flush();
    await act(async () => {
      cancelButton().click();
    });
    expect(vi.mocked(approveConversationApproval)).toHaveBeenCalledWith("c1", "dipu", "req-h2", { cancelled: true }, "t");
  });

  it("the pager stays exact with mixed generic and handoff approvals", async () => {
    await mountNavigator();
    await act(async () => deliverApproval({ requestId: "req-1" }));
    await act(async () =>
      deliverApproval({ requestId: "req-2", payload: { to: "zai", text: "gate text" } }),
    );
    await flush();
    // One card only; the newest arrival (the handoff) is selected.
    expect(container.querySelectorAll(".approval-card")).toHaveLength(1);
    expect(container.querySelector(".approval-pager-status")?.textContent).toBe("Approval 2 of 2");
    expect(container.querySelector(".approval-card")?.classList.contains("approval-card-handoff")).toBe(true);
    // Manual pager navigation selects the generic card and keeps focus on the pager button.
    const previous = Array.from(container.querySelectorAll<HTMLButtonElement>(".approval-pager button")).find(
      (candidate) => candidate.getAttribute("aria-label") === "Previous approval",
    );
    if (previous === undefined) throw new Error("previous pager button missing");
    // jsdom models keyboard reachability via focus(); click alone does not focus.
    previous.focus();
    await act(async () => {
      previous.click();
    });
    await flush();
    expect(container.querySelector(".approval-card")?.classList.contains("approval-card-handoff")).toBe(false);
    expect(document.activeElement).toBe(previous);
  });
});

describe("D4 static contract pins", () => {
  it("the activity row has tray-row styles and no animation was added", async () => {
    const styles = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    expect(styles).toContain(".conversation-activity-row");
    // Explicit pin: NO animated behavior was introduced for the activity row.
    const activityRule = styles.match(/\.conversation-activity-row[^{]*\{[^}]*\}/g) ?? [];
    expect(activityRule.length).toBeGreaterThan(0);
    for (const rule of activityRule) {
      expect(rule).not.toContain("animation");
    }
    expect(styles).not.toMatch(/@keyframes[^\n]*activity/);
    // The composer row keeps its flex path (never sticky, composer flexes).
    expect(styles).toMatch(/\.composer-action-row\s*\{[\s\S]*?flex:\s*none/);
    expect(styles).toMatch(/\.composer-action-row \.conversation-composer\s*\{[\s\S]*?flex:\s*1/);
  });

  it("the handoff card style is a modest separated non-error tint", async () => {
    const styles = await readFile(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    const rule = styles.match(/\.approval-card-handoff\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain("margin-top");
    expect(rule?.[0]).toContain("var(--accent)");
    expect(rule?.[0]).not.toContain("var(--error");
  });

  it("the navigator source adds no animated dots or new authority to the activity/handoff surfaces", async () => {
    const navigator = await readFile(join(process.cwd(), "web", "src", "ConversationNavigator.tsx"), "utf8");
    expect(navigator).toContain("conversation-activity-row");
    expect(navigator).not.toMatch(/conversation-activity-row[\s\S]{0,400}busy-dots/);
    // Approval/abort routes and exactly-one bodies are the pre-existing ones.
    expect(navigator).toContain("approveConversationApproval");
    expect(navigator).toContain("abortConversationRun");
  });
});
