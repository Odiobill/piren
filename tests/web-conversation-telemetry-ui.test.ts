// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { UnauthorizedError, attachConversation, fetchConversation, fetchConversationAgents, fetchConversationTelemetry } from "../web/src/api.js";

/**
 * Context cards + telemetry details popup — Workbench browser surface for the
 * accepted design `workbench-context-cards-telemetry-details-popup-design.md`.
 * The compact card row is the LAST interaction-tray row, below the composer
 * action row; each card is one native button with a decorative initial and a
 * clearly labelled truthful Context bar; activating a card opens one
 * focus-managed modal popup holding the explicit-only Refresh control. No
 * fetch on mount/selection/SSE/open, no retries, no storage, no red
 * action-badge semantics; the T6 generation guard keeps stale refresh
 * completions fully inert across selection changes.
 */

const CONVERSATION = {
  id: "c1",
  title: "Conversation with dipu",
  audience: ["dipu", "zai"],
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
    fetchConversationTelemetry: vi.fn(),
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

function deliverTelemetry(frame: Record<string, unknown>): void {
  const onTelemetry = timelineProps.onTelemetry as ((frame: unknown) => void) | undefined;
  if (onTelemetry === undefined) throw new Error("onTelemetry not wired");
  onTelemetry(frame);
}

function cardsRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-context-cards");
}

function cardButton(agent: string): HTMLButtonElement | null {
  return cardsRow()?.querySelector<HTMLButtonElement>(`button[aria-label^="${agent}:"]`) ?? null;
}

function cardProgressbar(agent: string): HTMLElement | null {
  return cardButton(agent)?.querySelector<HTMLElement>('[role="progressbar"]') ?? null;
}

function popup(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

async function openPopup(agent: string): Promise<HTMLElement> {
  const card = cardButton(agent);
  if (card === null) throw new Error(`no card for ${agent}`);
  await act(async () => {
    card.click();
  });
  await flush();
  const dialog = popup();
  if (dialog === null) throw new Error("popup did not open");
  return dialog;
}

function popupRefresh(dialog: HTMLElement, agent: string): HTMLButtonElement {
  const button = dialog.querySelector<HTMLButtonElement>(`button[aria-label="Refresh context telemetry for ${agent}"]`);
  if (button === null) throw new Error("no popup Refresh control");
  return button;
}

function trayChildOrder(): string[] {
  const tray = container.querySelector<HTMLElement>(".interaction-tray");
  if (tray === null) return [];
  return Array.from(tray.children).map((child) => child.className.split(" ")[0] ?? "");
}

beforeEach(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }, { name: "zai", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(fetchConversationTelemetry).mockReset();
  vi.mocked(attachConversation).mockReset().mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
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

const OK_FRAME = {
  conversationId: "c1",
  agent: "dipu",
  runId: "run-0001",
  contextState: "ok",
  context: { tokens: 60000, contextWindow: 200000, percent: 30 },
  model: { provider: "anthropic", id: "claude-sonnet-4" },
  thinkingLevel: "high",
  autoCompactionEnabled: true,
};

describe("Context cards tray row", () => {
  it("renders one compact card per audience member as the LAST tray row below the composer action row; the expanded telemetry row is gone; no fetch on mount/selection", async () => {
    await mountNavigator();
    const row = cardsRow();
    expect(row).not.toBeNull();
    expect(row?.parentElement?.classList.contains("interaction-tray")).toBe(true);
    // Old expanded row removed; cards never live inside the composer action row.
    expect(container.querySelector(".conversation-telemetry-row")).toBeNull();
    expect(container.querySelector(".composer-action-row .conversation-context-cards")).toBeNull();
    expect(trayChildOrder()).toEqual(["composer-action-row", "conversation-context-cards"]);
    // One native button per durable audience member, in durable order.
    const buttons = Array.from(row?.querySelectorAll("button") ?? []);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "dipu: No context telemetry yet; activate for details",
      "zai: No context telemetry yet; activate for details",
    ]);
    for (const button of buttons) {
      expect(button.type).toBe("button");
    }
    // Decorative initial circle is hidden from assistive tech.
    const initial = cardButton("dipu")?.querySelector(".context-card-initial");
    expect(initial?.getAttribute("aria-hidden")).toBe("true");
    expect(initial?.textContent).toBe("D");
    // Clearly labelled Context bar: never-sampled is truthful, with NO
    // aria-valuenow (indeterminate) and no invented zero/percent.
    const bar = cardProgressbar("dipu");
    expect(bar?.getAttribute("aria-label")).toBe("Context");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("100");
    expect(bar?.getAttribute("aria-valuenow")).toBeNull();
    expect(bar?.getAttribute("aria-valuetext")).toBe("No context telemetry yet");
    expect(cardButton("dipu")?.textContent).toContain("Context");
    expect(cardButton("dipu")?.textContent).not.toContain("0%");
    // No red/action-required badge semantics.
    expect(row?.querySelector(".badge, .status-badge, [data-attention]")).toBeNull();
    // No fetch happened on mount/selection.
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("a valid live SSE frame updates only the matching card's bar with two-decimal text; SSE receipt triggers no fetch", async () => {
    await mountNavigator();
    await act(async () => deliverTelemetry(OK_FRAME));
    await flush();
    const bar = cardProgressbar("dipu");
    expect(bar?.getAttribute("aria-valuenow")).toBe("30");
    expect(bar?.getAttribute("aria-valuetext")).toBe("Context usage: 30.00% of 200.0k window");
    expect(cardButton("dipu")?.textContent).toContain("30.00%");
    expect(cardButton("dipu")?.getAttribute("aria-label")).toBe("dipu: Context usage: 30.00% of 200.0k window; activate for details");
    // zai remains in the truthful never-sampled state.
    expect(cardProgressbar("zai")?.getAttribute("aria-valuenow")).toBeNull();
    expect(cardButton("zai")?.textContent).not.toContain("30.00%");
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("a post_compaction_pending frame renders a truthful neutral bar and never a fabricated percent", async () => {
    await mountNavigator();
    await act(async () =>
      deliverTelemetry({ conversationId: "c1", agent: "zai", runId: "run-0002", contextState: "post_compaction_pending", context: { tokens: null, contextWindow: 200000, percent: null } }),
    );
    await flush();
    const bar = cardProgressbar("zai");
    expect(bar?.getAttribute("aria-valuenow")).toBeNull();
    expect(bar?.getAttribute("aria-valuetext")).toBe("Context usage temporarily unavailable after compaction");
    expect(cardButton("zai")?.textContent).not.toContain("0%");
  });

  it("a truthful 0% is a real measured value: determinate bar with aria-valuenow 0 and 0.00% text", async () => {
    await mountNavigator();
    await act(async () =>
      deliverTelemetry({ ...OK_FRAME, context: { tokens: 0, contextWindow: 200000, percent: 0 } }),
    );
    await flush();
    const bar = cardProgressbar("dipu");
    expect(bar?.getAttribute("aria-valuenow")).toBe("0");
    expect(bar?.getAttribute("aria-valuetext")).toBe("Context usage: 0.00% of 200.0k window");
    expect(cardButton("dipu")?.textContent).toContain("0.00%");
  });

  it("tray order with approvals/activity present: approval cards, composer controls, context cards last (activity cards live in history)", async () => {
    await mountNavigator();
    const onApproval = timelineProps.onApproval as (approval: unknown) => void;
    const onActivityChange = timelineProps.onActivityChange as (runs: unknown) => void;
    await act(async () =>
      onApproval({ conversationId: "c1", agent: "dipu", requestId: "req-1", method: "confirm", payload: { title: "Proceed?" } }),
    );
    await act(async () => onActivityChange([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    // U1: the activity row moved out of the tray into .conversation-history.
    expect(trayChildOrder()).toEqual(["approval-cards", "composer-action-row", "conversation-context-cards"]);
    expect(container.querySelector(".conversation-history .conversation-activity-cards")).not.toBeNull();
  });

  it("read-only inspection renders no cards row", async () => {
    vi.mocked(attachConversation).mockResolvedValue({ conversation: CONVERSATION, attached: false, error: "agent not runnable" } as never);
    await mountNavigator();
    expect(container.querySelector(".attach-banner")).not.toBeNull();
    expect(cardsRow()).toBeNull();
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });
});

describe("Telemetry details popup", () => {
  it("card activation opens exactly one modal dialog named for the exact agent, focuses its Refresh control, and fetches nothing", async () => {
    await mountNavigator();
    const dialog = await openPopup("dipu");
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector("#telemetry-popup-heading")?.textContent).toBe("Context telemetry for dipu");
    expect(dialog.getAttribute("aria-labelledby")).toBe("telemetry-popup-heading");
    // Initial focus is the explicit Refresh control.
    const refresh = popupRefresh(dialog, "dipu");
    expect(document.activeElement).toBe(refresh);
    // Truthful never-sampled content; no invented fields.
    expect(dialog.textContent).toContain("No context telemetry yet");
    expect(dialog.textContent).not.toContain("0%");
    // Opening fetched nothing.
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("popup shows concise short labelled lines for exactly the permitted bounded fields, with two-decimal percent and no expanded sentence", async () => {
    await mountNavigator();
    await act(async () => deliverTelemetry(OK_FRAME));
    await flush();
    const dialog = await openPopup("dipu");
    expect(dialog.textContent).toContain("Context usage: 30.00% of 200.0k window");
    expect(dialog.textContent).toContain("60.0k");
    expect(dialog.textContent).toContain("200.0k");
    expect(dialog.textContent).toContain("30.00%");
    expect(dialog.textContent).toContain("anthropic/claude-sonnet-4");
    expect(dialog.textContent).toContain("high");
    expect(dialog.textContent).toContain("on");
    // Concise labelled lines: agent and truthful state are dt/dd rows, not a
    // dense sentence and not a standalone unlabelled paragraph.
    const rows = Array.from(dialog.querySelectorAll(".telemetry-popup-field"));
    const pairs = rows.map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
    expect(pairs).toEqual([
      ["Agent", "dipu"],
      ["State", "Context usage: 30.00% of 200.0k window"],
      ["Context tokens", "60.0k"],
      ["Context window", "200.0k"],
      ["Context usage", "30.00%"],
      ["Model", "anthropic/claude-sonnet-4"],
      ["Thinking", "high"],
      ["Auto-compaction", "on"],
    ]);
    expect(dialog.querySelector(".telemetry-popup-state")).toBeNull();
    // Absence of the old expanded T6 sentence format (dense dot-separated line).
    expect(dialog.textContent).not.toContain("dipu · 60.0k / 200.0k context");
    // Excluded: run/session ids, totals, cost.
    expect(dialog.textContent).not.toContain("run-0001");
    expect(dialog.textContent?.toLowerCase()).not.toContain("cost");
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("Escape and Close dismiss the popup and return focus to the invoking card", async () => {
    await mountNavigator();
    const card = cardButton("dipu");
    const dialog = await openPopup("dipu");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(card);

    const dialog2 = await openPopup("dipu");
    const close = dialog2.querySelector<HTMLButtonElement>('button[aria-label="Close context telemetry for dipu"]');
    expect(close).not.toBeNull();
    await act(async () => {
      close?.click();
    });
    await flush();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("Tab traps focus inside the dialog (last → first, Shift+Tab first → last)", async () => {
    await mountNavigator();
    const dialog = await openPopup("dipu");
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    last.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);
    first.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("activating a second card swaps the single popup to that exact pair", async () => {
    await mountNavigator();
    await openPopup("dipu");
    expect(popup()?.textContent).toContain("Context telemetry for dipu");
    await act(async () => {
      cardButton("zai")?.click();
    });
    await flush();
    const dialogs = container.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(1);
    expect(popup()?.textContent).toContain("Context telemetry for zai");
    expect(popup()?.textContent).not.toContain("Context telemetry for dipu");
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("a selection change closes the popup", async () => {
    await mountNavigator();
    await openPopup("dipu");
    const CONVERSATION_B = { ...CONVERSATION, id: "c2", title: "Conversation B", path: "collaboration/conversations/c2/index.md" };
    vi.mocked(fetchConversation).mockImplementation(async (id: string) => (id === "c2" ? CONVERSATION_B : CONVERSATION));
    vi.mocked(attachConversation).mockResolvedValue({ conversation: CONVERSATION_B, attached: true, gate: { ok: true, missing: [], malformed: [] } });
    await act(async () => {
      window.location.hash = "#conversation/c2";
    });
    await flush();
    await flush();
    expect(popup()).toBeNull();
    expect(cardsRow()).not.toBeNull();
  });
});

describe("explicit-only popup Refresh", () => {
  it("one click → one exact authenticated GET; live and no-live results render truthfully in the popup", async () => {
    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "live", contextState: "no_window" });
    await mountNavigator();
    const dialog = await openPopup("dipu");
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
    await act(async () => {
      popupRefresh(dialog, "dipu").click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(popup()?.textContent).toContain("No context window information for this session");

    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "no_live_session" });
    await act(async () => {
      popupRefresh(popup() as HTMLElement, "dipu").click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(2);
    expect(popup()?.textContent).toContain("No live session");
  });

  it("busy disables the control with a truthful label and Escape cannot dismiss mid-flight", async () => {
    let resolveRefresh: ((value: unknown) => void) | undefined;
    vi.mocked(fetchConversationTelemetry).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    await mountNavigator();
    const dialog = await openPopup("dipu");
    const refresh = popupRefresh(dialog, "dipu");
    await act(async () => {
      refresh.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
    const busyButton = popup()?.querySelector<HTMLButtonElement>('button[aria-label="Refresh context telemetry for dipu"]');
    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.textContent).toContain("Refreshing…");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    // Still open: a bounded failure must stay visible if the request fails.
    expect(popup()).not.toBeNull();
    await act(async () => {
      resolveRefresh?.({ sessionState: "live", contextState: "no_window" });
    });
    await flush();
    expect(popup()?.textContent).toContain("No context window information for this session");
  });

  it("401 routes through onUnauthorized; bounded failure keeps prior truthful data and reports in the popup", async () => {
    const onUnauthorized = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ConversationNavigator, {
          token: "t",
          onUnauthorized,
          onValidated: () => {},
          onConversationsChanged: () => {},
        }),
      );
    });
    await flush();
    await act(async () => deliverTelemetry(OK_FRAME));
    await flush();
    const dialog = await openPopup("dipu");
    expect(dialog.textContent).toContain("30.00%");

    vi.mocked(fetchConversationTelemetry).mockRejectedValueOnce(new UnauthorizedError());
    await act(async () => {
      popupRefresh(popup() as HTMLElement, "dipu").click();
    });
    await flush();
    expect(onUnauthorized).toHaveBeenCalled();

    vi.mocked(fetchConversationTelemetry).mockRejectedValueOnce(new Error("conversation telemetry HTTP 500"));
    await act(async () => {
      popupRefresh(popup() as HTMLElement, "dipu").click();
    });
    await flush();
    // The prior good value stays (not relabeled as fresh) and the failure is
    // visible inside the popup.
    expect(popup()?.textContent).toContain("30.00%");
    expect(popup()?.querySelector('[role="alert"]')?.textContent).toContain("500");
  });
});

describe("fetchConversationTelemetry (narrow T4 adapter, unchanged)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends exactly one authenticated GET to the exact encoded route and parses the bounded result", async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, authorization: headers.authorization ?? headers.Authorization });
      return new Response(JSON.stringify({ sessionState: "live", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 } }), { status: 200 });
    });
    const { fetchConversationTelemetry: realFetch } = await vi.importActual<typeof import("../web/src/api.js")>("../web/src/api.js");
    const result = await realFetch("c1/odd", "dipu", "secret-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/conversations/c1%2Fodd/agents/dipu/telemetry");
    expect(calls[0]?.authorization).toBe("Bearer secret-token");
    expect(result).toMatchObject({ sessionState: "live", contextState: "ok" });
  });

  it("parses no_live_session and surfaces 401 as UnauthorizedError", async () => {
    const { fetchConversationTelemetry: realFetch } = await vi.importActual<typeof import("../web/src/api.js")>("../web/src/api.js");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ sessionState: "no_live_session" }), { status: 200 }));
    expect(await realFetch("c1", "dipu", "t")).toEqual({ sessionState: "no_live_session" });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));
    await expect(realFetch("c1", "dipu", "t")).rejects.toThrow(UnauthorizedError);
  });

  it("non-401 failures and invalid payloads throw (never an invented state)", async () => {
    const { fetchConversationTelemetry: realFetch } = await vi.importActual<typeof import("../web/src/api.js")>("../web/src/api.js");
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    await expect(realFetch("c1", "dipu", "t")).rejects.toThrow(/500/);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ sessionState: "live", contextState: "ok", cost: 1 }), { status: 200 }));
    await expect(realFetch("c1", "dipu", "t")).rejects.toThrow();
  });
});

describe("cross-selection refresh race guard (T6, preserved)", () => {
  const CONVERSATION_B = {
    id: "c2",
    title: "Conversation B",
    audience: ["dipu"],
    status: "open",
    path: "collaboration/conversations/c2/index.md",
    createdBy: "steward",
    created: "2026-08-15T14:00:00.000Z",
    updated: "2026-08-15T14:00:00.000Z",
  };

  it("a popup refresh resolving after the selection changed is fully inert; a same-selection refresh applies exactly once", async () => {
    let resolveA: ((value: unknown) => void) | undefined;
    vi.mocked(fetchConversationTelemetry).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    await mountNavigator();

    // Start an unresolved refresh for Conversation A's dipu from the popup.
    const dialog = await openPopup("dipu");
    await act(async () => {
      popupRefresh(dialog, "dipu").click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(popup()?.textContent).toContain("Refreshing…");

    // Switch to Conversation B (fresh manifest + attach for c2).
    vi.mocked(fetchConversation).mockImplementation(async (id: string) => (id === "c2" ? CONVERSATION_B : CONVERSATION));
    vi.mocked(attachConversation).mockResolvedValue({ conversation: CONVERSATION_B, attached: true, gate: { ok: true, missing: [], malformed: [] } });
    await act(async () => {
      window.location.hash = "#conversation/c2";
    });
    await flush();
    await flush();
    // The popup closed with the selection change; B's cards show no busy state.
    expect(popup()).toBeNull();
    expect(cardsRow()?.textContent).toContain("dipu");

    // A's refresh resolves late: fully inert for B — no telemetry, no error,
    // no busy state, no second request.
    await act(async () => {
      resolveA?.({ sessionState: "live", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 } });
    });
    await flush();
    expect(cardProgressbar("dipu")?.getAttribute("aria-valuenow")).toBeNull();
    expect(cardsRow()?.textContent).not.toContain("Refreshing…");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);

    // A same-selection refresh on B still applies exactly once.
    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "live", contextState: "no_window" });
    const dialogB = await openPopup("dipu");
    await act(async () => {
      popupRefresh(dialogB, "dipu").click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenLastCalledWith("c2", "dipu", "t");
    expect(popup()?.textContent).toContain("No context window information for this session");
  });
});

describe("commit-window race guard (T6 final correction, preserved)", () => {
  const CONVERSATION_B2 = {
    id: "c2",
    title: "Conversation B",
    audience: ["dipu"],
    status: "open",
    path: "collaboration/conversations/c2/index.md",
    createdBy: "steward",
    created: "2026-08-15T14:00:00.000Z",
    updated: "2026-08-15T14:00:00.000Z",
  };

  it("invalidates the refresh generation synchronously with the selection commit (layout-effect boundary, static pin)", async () => {
    // Structural guard: the generation bump lives in a useLayoutEffect keyed
    // on surfaceKey. Layout effects run synchronously with the selection
    // commit, while a refresh promise can only settle afterwards (promise
    // continuations are microtasks that run after the synchronous commit and
    // its layout effects). A stale completion therefore ALWAYS observes the
    // new generation after B commits — there is no passive-effect window.
    const source = await readFile(join(process.cwd(), "web", "src", "ConversationNavigator.tsx"), "utf8");
    const bump = source.indexOf("telemetryGenerationRef.current += 1;");
    expect(bump).toBeGreaterThan(-1);
    const boundary = source.lastIndexOf("useLayoutEffect(() => {", bump);
    expect(boundary).toBeGreaterThan(-1);
    expect(source.slice(boundary, bump + 400)).toContain("[surfaceKey]");
    // Not left in a passive effect.
    const passive = source.lastIndexOf("useEffect(() => {", bump);
    expect(passive === -1 || passive < boundary).toBe(true);
  });

  it("a refresh settling in the selection-change batch never leaves A telemetry, error, or busy state in B", async () => {
    let resolveA: ((value: unknown) => void) | undefined;
    vi.mocked(fetchConversationTelemetry).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    await mountNavigator();
    const dialog = await openPopup("dipu");
    await act(async () => {
      popupRefresh(dialog, "dipu").click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);

    vi.mocked(fetchConversation).mockImplementation(async (id: string) => (id === "c2" ? CONVERSATION_B2 : CONVERSATION));
    vi.mocked(attachConversation).mockResolvedValue({ conversation: CONVERSATION_B2, attached: true, gate: { ok: true, missing: [], malformed: [] } });

    // Adversarial batch: the hashchange and A's late resolution happen
    // together. Whether the continuation lands pre-commit (legitimately
    // applied to the still-selected A, then cleared at B's commit) or
    // post-commit (rejected by the layout-effect generation guard), B must
    // end with none of A's telemetry, error, or busy state and no new fetch.
    window.location.hash = "#conversation/c2";
    resolveA?.({ sessionState: "live", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    await flush();

    expect(popup()).toBeNull();
    expect(cardsRow()).not.toBeNull();
    expect(cardsRow()?.textContent).toContain("dipu");
    expect(cardProgressbar("dipu")?.getAttribute("aria-valuenow")).toBeNull();
    expect(cardsRow()?.textContent).not.toContain("Refreshing…");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
  });
});
