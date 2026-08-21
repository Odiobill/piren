// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import { UnauthorizedError, assignInboxTask, fetchConversationAgents, fetchServiceStatus } from "../web/src/api.js";

/**
 * T1 — Dashboard Assign-task affordance (jsdom). Exactly-one selected
 * runnable agent gates the control; an accessible modal identifies the
 * recipient and requires trimmed subject + details; submission uses ONLY the
 * existing authenticated POST /api/vault/inbox contract through the typed
 * client; one in-flight submit prevents duplicates; success reports only
 * that a task was created (never contact/notification/wakeup/execution);
 * errors stay bounded with an explicit retry only; cancel discards the
 * browser-only draft.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchServiceStatus: vi.fn(),
    assignInboxTask: vi.fn(),
  };
});

const ROSTER = {
  agents: [
    { name: "dipu", online: true, model: "anthropic/claude-opus-4.6" },
    { name: "zora", online: false },
  ],
};

const SERVICE_SNAPSHOT: import("../web/src/service-observation.js").ServiceStatusSnapshot = {
  observedAt: "2026-08-21T12:00:00.000Z",
  manager: "systemd-user",
  targets: [
    { target: "telegram", state: "inactive" },
    { target: "discord", state: "inactive" },
    { target: "scheduler", state: "not-installed" },
  ],
};

const CREATED = {
  taskId: "20260821T210612217Z-check-the-backups",
  path: "team/dipu/inbox/20260821T210612217Z-check-the-backups.md",
  from: "steward",
  to: "dipu",
  status: "pending" as const,
};

let container: HTMLDivElement;
let root: Root;

function render(element: ReactElement): void {
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDashboard(overrides?: { onUnauthorized?: () => void }): { unauthorized: () => number } {
  let unauthorizedCalls = 0;
  render(
    createElement(DashboardView, {
      token: "test-token",
      onUnauthorized: overrides?.onUnauthorized ?? (() => void unauthorizedCalls++),
      onValidated: () => {},
      onOpenConversation: () => {},
      reloadKey: 0,
    }),
  );
  return { unauthorized: () => unauthorizedCalls };
}

function agentButton(name: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-agent="${name}"]`);
  if (el === null) throw new Error(`agent button missing: ${name}`);
  return el;
}

function assignButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".dashboard-assign");
  if (el === null) throw new Error("assign task button missing");
  return el;
}

function dialog(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (el === null) throw new Error("assign task dialog missing");
  return el;
}

async function openModalFor(name: string): Promise<void> {
  await flush();
  act(() => {
    agentButton(name).click();
  });
  act(() => {
    assignButton().click();
  });
  await flush();
}

function subjectInput(): HTMLInputElement {
  const el = dialog().querySelector<HTMLInputElement>("#assign-task-subject");
  if (el === null) throw new Error("subject input missing");
  return el;
}

function detailsInput(): HTMLTextAreaElement {
  const el = dialog().querySelector<HTMLTextAreaElement>("#assign-task-details");
  if (el === null) throw new Error("details input missing");
  return el;
}

function submitButton(): HTMLButtonElement {
  const el = Array.from(dialog().querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.type === "submit",
  );
  if (el === undefined) throw new Error("submit button missing");
  return el;
}

// React 19 controlled inputs: write through the native value setter, then
// dispatch the input event so the onChange handler sees the new value.
function typeText(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(fetchConversationAgents).mockReset();
  vi.mocked(fetchServiceStatus).mockReset();
  vi.mocked(assignInboxTask).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchServiceStatus).mockResolvedValue(SERVICE_SNAPSHOT);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("DashboardView Assign task (T1)", () => {
  it("disables Assign task without a selection and enables it with exactly one selected runnable agent", async () => {
    renderDashboard();
    await flush();
    expect(assignButton().disabled).toBe(true);
    act(() => {
      agentButton("dipu").click();
    });
    expect(assignButton().disabled).toBe(false);
    // Offline agents are never selectable, so selecting one is impossible;
    // the control stays keyed to the exactly-one runnable selection.
    expect(agentButton("zora").disabled).toBe(true);
  });

  it("opens an accessible modal identifying the recipient, focuses the subject input, and cancels cleanly", async () => {
    renderDashboard();
    await openModalFor("dipu");
    const d = dialog();
    expect(d.getAttribute("aria-labelledby")).toBe("assign-task-heading");
    expect(d.textContent).toContain("dipu");
    expect(document.activeElement).toBe(subjectInput());
    // Required fields carry native accessible-required semantics; the
    // trimmed-content submit gating stays in place.
    expect(subjectInput().required).toBe(true);
    expect(detailsInput().required).toBe(true);
    // Cancel discards the browser-only draft and closes the modal.
    act(() => {
      typeText(subjectInput(), "draft that must be discarded");
    });
    const cancel = Array.from(d.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Cancel");
    act(() => {
      cancel?.click();
    });
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await openModalFor("dipu");
    expect(subjectInput().value).toBe("");
    // Closing returns focus to the invoking Assign-task control.
    const cancel2 = Array.from(dialog().querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Cancel");
    act(() => {
      cancel2?.click();
    });
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(assignButton());
  });

  it("keeps submit disabled until both required fields have trimmed content", async () => {
    renderDashboard();
    await openModalFor("dipu");
    expect(submitButton().disabled).toBe(true);
    act(() => {
      typeText(subjectInput(), "   ");
      typeText(detailsInput(), "details");
    });
    expect(submitButton().disabled).toBe(true);
    act(() => {
      typeText(subjectInput(), "Check the backups");
    });
    expect(submitButton().disabled).toBe(false);
    act(() => {
      typeText(detailsInput(), "");
    });
    expect(submitButton().disabled).toBe(true);
  });

  it("submits exactly {to, title, body} once with trimmed values over the existing route contract", async () => {
    vi.mocked(assignInboxTask).mockResolvedValue(CREATED);
    renderDashboard();
    await openModalFor("dipu");
    act(() => {
      typeText(subjectInput(), "  Check the backups  ");
      typeText(detailsInput(), "Verify the nightly backup ran.\n");
    });
    await act(async () => {
      submitButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledWith("dipu", "Check the backups", "Verify the nightly backup ran.", "test-token");
  });

  it("prevents duplicate submits while one request is in flight and never auto-retries", async () => {
    let release!: (value: typeof CREATED) => void;
    vi.mocked(assignInboxTask).mockImplementation(
      () =>
        new Promise<typeof CREATED>((resolve) => {
          release = resolve;
        }),
    );
    renderDashboard();
    await openModalFor("dipu");
    act(() => {
      typeText(subjectInput(), "Check the backups");
      typeText(detailsInput(), "Verify.");
    });
    await act(async () => {
      submitButton().click();
    });
    expect(submitButton().disabled).toBe(true);
    act(() => {
      submitButton().click();
    });
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(CREATED);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
  });

  it("reports only truthful creation on success — no contact, notification, wakeup, or execution claim", async () => {
    vi.mocked(assignInboxTask).mockResolvedValue(CREATED);
    renderDashboard();
    await openModalFor("dipu");
    act(() => {
      typeText(subjectInput(), "Check the backups");
      typeText(detailsInput(), "Verify.");
    });
    await act(async () => {
      submitButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const notice = container.querySelector(".dashboard-assign-notice");
    expect(notice?.textContent).toContain("A task was created for dipu.");
    const text = container.textContent ?? "";
    expect(text).not.toContain("notified");
    expect(text).not.toContain("contacted");
    expect(text).not.toContain("awake");
    expect(text).not.toContain("is running");
    expect(text).not.toContain("executing");
  });

  it("routes a 401 to the shell's established auth-recovery callback instead of an ordinary error", async () => {
    const { unauthorized } = renderDashboard();
    vi.mocked(assignInboxTask).mockRejectedValueOnce(new UnauthorizedError());
    await openModalFor("dipu");
    act(() => {
      typeText(subjectInput(), "Check the backups");
      typeText(detailsInput(), "Verify.");
    });
    await act(async () => {
      submitButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unauthorized()).toBe(1);
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
    // The modal never auto-retries and stays bounded.
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
  });

  it("shows a bounded error with an explicit retry only — no automatic retry", async () => {
    vi.mocked(assignInboxTask).mockRejectedValueOnce(new Error("Target agent not found in vault: dipu"));
    renderDashboard();
    await openModalFor("dipu");
    act(() => {
      typeText(subjectInput(), "Check the backups");
      typeText(detailsInput(), "Verify.");
    });
    await act(async () => {
      submitButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialog().textContent).toContain("Target agent not found in vault: dipu");
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
    await flush();
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(1);
    // Retry exists but is explicit only.
    const retry = Array.from(dialog().querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Retry"));
    expect(retry).toBeDefined();
    vi.mocked(assignInboxTask).mockResolvedValueOnce(CREATED);
    await act(async () => {
      retry?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(assignInboxTask)).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
