// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationDetailsModal } from "../web/src/ConversationDetailsModal.js";
import type { ConversationRecord } from "../web/src/conversations.js";
import type { ConversationWorkflowBudgetsView } from "../web/src/conversation-workflow-budget.js";
import { WorkflowBudgetHttpError } from "../web/src/api.js";

/**
 * B5 — W2 Conversation-level "Workflow budget" section in the details modal.
 * The browser renders the bounded B4 server view and sends one typed
 * authenticated CAS request; it never derives/selects roots, persists a
 * budget, polls, retries automatically, or implies a per-agent budget.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationWorkflowBudgets: vi.fn(),
    updateConversationWorkflowBudget: vi.fn(),
  };
});
import {
  fetchConversationWorkflowBudgets,
  updateConversationWorkflowBudget,
} from "../web/src/api.js";

const CONVERSATION: ConversationRecord = {
  id: "20260829T120000000Z-budget",
  title: "Budget conversation",
  path: "collaboration/conversations/20260829T120000000Z-budget/index.md",
  createdBy: "steward",
  audience: ["zai"],
  status: "open",
  created: "2026-08-29T12:00:00.000Z",
  updated: "2026-08-29T12:00:00.000Z",
};

const ROOT_ID = "20260829T110000000Z-root-1";
const ROOT_TWO_ID = "20260829T110500000Z-root-2";

function budgetsView(overrides: Partial<ConversationWorkflowBudgetsView> = {}): ConversationWorkflowBudgetsView {
  return {
    roots: [
      {
        root_event_id: ROOT_ID,
        sequence: 1,
        base: { edges: 8, reworkRounds: 2 },
        effective: { edges: 8, reworkRounds: 2 },
        consumed: { edges: 6 },
        worstPairOccurrences: 1,
        low: false,
        exhausted: false,
        warnings: [],
        omittedWarnings: 0,
      },
      {
        root_event_id: ROOT_TWO_ID,
        sequence: 2,
        base: { edges: 8, reworkRounds: 2 },
        effective: { edges: 10, reworkRounds: 3 },
        consumed: { edges: 10 },
        worstPairOccurrences: 3,
        low: true,
        exhausted: true,
        warnings: ["budget update from-value does not match the current effective edges value"],
        omittedWarnings: 2,
      },
    ],
    total: 2,
    omitted: 0,
    association: { zai: { root_event_id: ROOT_ID, association: "active-run" } },
    ...overrides,
  };
}

const mockedFetchBudgets = vi.mocked(fetchConversationWorkflowBudgets);
const mockedUpdateBudget = vi.mocked(updateConversationWorkflowBudget);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockedFetchBudgets.mockReset().mockResolvedValue(budgetsView());
  mockedUpdateBudget.mockReset().mockResolvedValue({ status: "updated", effective: { edges: 10, reworkRounds: 2 } });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

function Harness(props: {
  budgets?: ConversationWorkflowBudgetsView | Error;
  onWorkflowBudgetsChanged?: (conversationId: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(true);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const confirmArchiveRef = useRef<HTMLButtonElement>(null);
  const onClose = vi.fn(() => setOpen(false));
  if (!open) return createElement("div", { "data-modal-closed": "true" });
  return createElement(ConversationDetailsModal, {
    conversation: CONVERSATION,
    agents: [],
    lifecyclePhase: "idle",
    lifecycleError: null,
    confirmingArchive: false,
    archiveButtonRef,
    confirmArchiveRef,
    onArchiveRequest: () => {},
    onCancelArchive: () => {},
    onConfirmArchive: () => {},
    onReopen: () => {},
    onLifecycleRetry: () => {},
    onRename: async () => null,
    onClose,
    token: "t",
    onWorkflowBudgetsChanged: props.onWorkflowBudgetsChanged ?? (() => {}),
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function budgetSection(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".workflow-budget");
}

function saveButton(rootId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Save workflow budget for root ${rootId}"]`);
}

function dimensionInput(rootId: string, dimension: "edges" | "rework"): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[data-root="${rootId}"][data-dimension="${dimension}"]`);
}

function setDraft(rootId: string, dimension: "edges" | "rework", value: string): void {
  const input = dimensionInput(rootId, dimension);
  if (input === null) throw new Error(`missing ${dimension} input for ${rootId}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConversationDetailsModal Workflow budget section (B5)", () => {
  it("renders server facts truthfully: consumed/effective/base/remaining per root, multiple roots as a distinct list, fixed depth as non-editable context", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();

    const section = budgetSection();
    expect(section).not.toBeNull();
    const roots = section?.querySelectorAll<HTMLElement>(".workflow-budget-root") ?? [];
    expect(roots).toHaveLength(2);
    // Root one: consumed 6 of 8 effective (base 8), remaining 2.
    expect(roots[0]?.textContent).toContain("consumed 6 of 8 effective");
    expect(roots[0]?.textContent).toContain("base 8");
    expect(roots[0]?.textContent).toContain("remaining 2");
    expect(roots[0]?.textContent).toContain(ROOT_ID);
    // Root two is a DISTINCT root with its own exhausted facts.
    expect(roots[1]?.textContent).toContain("consumed 10 of 10 effective");
    expect(roots[1]?.textContent).toContain("remaining 0");
    expect(roots[1]?.textContent).toContain(ROOT_TWO_ID);
    // Fixed depth is context, never editable: no depth input exists.
    expect(section?.querySelector('input[data-dimension="depth"]')).toBeNull();
    expect(section?.textContent).toContain("Depth: 3 (fixed)");
    // Warnings render truthfully, including the omitted count.
    expect(roots[1]?.textContent).toContain("budget update from-value does not match");
    expect(roots[1]?.textContent).toContain("2 more ignored budget update(s) not shown");
  });

  it("zero roots render no fabricated budget section or control", async () => {
    mockedFetchBudgets.mockResolvedValue({
      roots: [],
      total: 0,
      omitted: 0,
      association: {},
    });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();
    expect(budgetSection()).toBeNull();
    expect(container.querySelector(".workflow-budget")).toBeNull();
  });

  it("Save sends exactly the closed B4 request shape with last fetched CAS values, and Save is gated until a target changes", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();

    // Gated: no change yet.
    expect(saveButton(ROOT_ID)?.disabled).toBe(true);

    setDraft(ROOT_ID, "edges", "10");
    expect(saveButton(ROOT_ID)?.disabled).toBe(false);

    await act(async () => {
      saveButton(ROOT_ID)?.click();
    });
    await flush();

    expect(mockedUpdateBudget).toHaveBeenCalledTimes(1);
    expect(mockedUpdateBudget).toHaveBeenCalledWith(
      CONVERSATION.id,
      {
        root_event_id: ROOT_ID,
        edges: 10,
        expected_effective: { edges: 8, reworkRounds: 2 },
      },
      "t",
    );
    // Success re-reads the workflow view through the same bounded fetch.
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(2);
  });

  it("in-flight Save suppresses Escape and disables Close/Cancel so a failure stays visible", async () => {
    let release!: (value: { status: "updated"; effective: { edges: number; reworkRounds: number } }) => void;
    mockedUpdateBudget.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();

    setDraft(ROOT_ID, "edges", "10");
    await act(async () => {
      saveButton(ROOT_ID)?.click();
    });

    // In flight: inputs and both close affordances disabled; Escape suppressed.
    expect(saveButton(ROOT_ID)?.disabled).toBe(true);
    expect(dimensionInput(ROOT_ID, "edges")?.disabled).toBe(true);
    const closeButton = container.querySelector<HTMLButtonElement>(".details-close");
    expect(closeButton?.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // Modal still open (no data-modal-closed node swap).
    expect(budgetSection()).not.toBeNull();

    await act(async () => {
      release({ status: "updated", effective: { edges: 10, reworkRounds: 2 } });
    });
    await flush();
    // After success the suppression lifts (close affordances usable again).
    expect(container.querySelector<HTMLButtonElement>(".details-close")?.disabled).toBe(false);
  });

  it("a bounded 400 failure stays visible with explicit Retry, never a fake success or a silent clamp", async () => {
    mockedUpdateBudget.mockRejectedValueOnce(
      new WorkflowBudgetHttpError(400, "budget update must strictly raise the current effective value"),
    );
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();

    // B5 correction: an out-of-cap CHANGED target is submitted UNCHANGED —
    // the B4 gateway is the validation authority and its bounded 400 is the
    // truthful outcome (never locally clamped, never disabled).
    setDraft(ROOT_ID, "edges", "99");
    expect(saveButton(ROOT_ID)?.disabled).toBe(false);

    // A non-raising target is submittable: the gateway's bounded 400 is the
    // truthful outcome, submitted as-is (never clamped).
    setDraft(ROOT_ID, "edges", "4");
    expect(saveButton(ROOT_ID)?.disabled).toBe(false);
    await act(async () => {
      saveButton(ROOT_ID)?.click();
    });
    await flush();

    expect(mockedUpdateBudget).toHaveBeenCalledWith(
      CONVERSATION.id,
      expect.objectContaining({ edges: 4, expected_effective: { edges: 8, reworkRounds: 2 } }),
      "t",
    );
    // Bounded failure stays visible with explicit Retry (no fake success).
    const alert = container.querySelector<HTMLElement>(".workflow-budget .workflow-budget-error[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("strictly raise");
    expect(alert?.textContent).toContain("Retry");
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(1); // no success re-read

    // Explicit Retry re-sends the same bounded request; no auto retry happened.
    mockedUpdateBudget.mockResolvedValueOnce({ status: "updated", effective: { edges: 10, reworkRounds: 2 } });
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await flush();
    expect(mockedUpdateBudget).toHaveBeenCalledTimes(2);
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(2);
  });

  it("browser hygiene: no storage writes, no polling (one fetch on open, re-fetch only on success), no per-agent budget claim", async () => {
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(1);
    // Settle long enough to prove no polling loop fires.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(1);
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
    // The section never implies a per-agent budget: no agent names in it.
    const section = budgetSection();
    expect(section?.textContent).not.toContain("zai");
  });
});

describe("ConversationDetailsModal Workflow budget section (B5 correction)", () => {
  it("an out-of-cap changed target submits exactly as typed, surfaces the gateway bounded 400, and is never locally clamped", async () => {
    mockedUpdateBudget.mockRejectedValueOnce(
      new WorkflowBudgetHttpError(400, "budget edges exceed the fixed cap"),
    );
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();

    setDraft(ROOT_ID, "edges", "99");
    expect(saveButton(ROOT_ID)?.disabled).toBe(false);
    await act(async () => {
      saveButton(ROOT_ID)?.click();
    });
    await flush();

    // Submitted exactly 99: the gateway is the validation authority.
    expect(mockedUpdateBudget).toHaveBeenCalledWith(
      CONVERSATION.id,
      expect.objectContaining({ edges: 99, expected_effective: { edges: 8, reworkRounds: 2 } }),
      "t",
    );
    // Bounded 400 stays visible in role=alert; never clamped into success.
    const alert = container.querySelector<HTMLElement>(".workflow-budget .workflow-budget-error[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("budget edges exceed the fixed cap");
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(1);
  });

  it("any in-flight budget save interlocks the whole modal: another root cannot POST, and normal operation resumes after settle", async () => {
    let releaseA!: (value: { status: "updated"; effective: { edges: number; reworkRounds: number } }) => void;
    mockedUpdateBudget.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseA = resolve;
      }),
    );
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView() }));
    });
    await flush();

    // Root A in flight.
    setDraft(ROOT_ID, "edges", "10");
    await act(async () => {
      saveButton(ROOT_ID)?.click();
    });
    expect(mockedUpdateBudget).toHaveBeenCalledTimes(1);

    // Root B: inputs/Save disabled by the MODAL-WIDE interlock; clicking it
    // must NOT send a second POST.
    expect(saveButton(ROOT_TWO_ID)?.disabled).toBe(true);
    expect(dimensionInput(ROOT_TWO_ID, "edges")?.disabled).toBe(true);
    await act(async () => {
      saveButton(ROOT_TWO_ID)?.click();
    });
    await flush();
    expect(mockedUpdateBudget).toHaveBeenCalledTimes(1);
    // Escape also stays suppressed while any root is in flight.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(budgetSection()).not.toBeNull();

    // Settle A: normal operation resumes (B editable/enabled again).
    await act(async () => {
      releaseA({ status: "updated", effective: { edges: 10, reworkRounds: 2 } });
    });
    await flush();
    expect(saveButton(ROOT_TWO_ID)?.disabled).toBe(true); // still gated: B unchanged
    setDraft(ROOT_TWO_ID, "edges", "12");
    expect(saveButton(ROOT_TWO_ID)?.disabled).toBe(false);
  });

  it("a successful POST whose follow-up GET fails keeps the modal mounted, never re-gates, and Retry only re-reads (no second POST)", async () => {
    // POST succeeds; the FIRST re-read fails.
    mockedUpdateBudget.mockResolvedValueOnce({ status: "updated", effective: { edges: 10, reworkRounds: 2 } });
    mockedFetchBudgets.mockResolvedValueOnce(budgetsView()); // open fetch
    mockedFetchBudgets.mockRejectedValueOnce(new WorkflowBudgetHttpError(500, "internal error")); // failed re-read
    const onWorkflowBudgetsChanged = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { budgets: budgetsView(), onWorkflowBudgetsChanged }));
    });
    await flush();

    setDraft(ROOT_ID, "edges", "10");
    await act(async () => {
      saveButton(ROOT_ID)?.click();
    });
    await flush();

    // POST exactly once; the accepted mutation is never replayed.
    expect(mockedUpdateBudget).toHaveBeenCalledTimes(1);
    // The re-gate has NOT run (only a successful re-read may invoke it).
    expect(onWorkflowBudgetsChanged).not.toHaveBeenCalled();
    // Modal remains mounted with the bounded reload-failure alert.
    expect(budgetSection()).not.toBeNull();
    const reloadAlert = container.querySelector<HTMLElement>(
      ".workflow-budget .workflow-budget-reload-error[role='alert']",
    );
    expect(reloadAlert).not.toBeNull();
    expect(reloadAlert?.textContent).toContain("could not be re-read");

    // Retry retries ONLY the re-read/re-gate: no second POST.
    await act(async () => {
      reloadAlert?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await flush();
    expect(mockedUpdateBudget).toHaveBeenCalledTimes(1);
    expect(mockedFetchBudgets).toHaveBeenCalledTimes(3); // open + failed + retried
    expect(onWorkflowBudgetsChanged).toHaveBeenCalledTimes(1);
    expect(onWorkflowBudgetsChanged).toHaveBeenCalledWith(CONVERSATION.id);
    // Reload alert cleared after the successful re-read.
    expect(container.querySelector(".workflow-budget-reload-error")).toBeNull();
  });
});
