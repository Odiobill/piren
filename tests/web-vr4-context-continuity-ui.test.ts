// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { agentDisplayName } from "../web/src/agent-display.js";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { attachConversation, fetchConversation, fetchConversationAgents, fetchConversationTelemetry } from "../web/src/api.js";
import { contextContinuityStore } from "../web/src/context-continuity-store.js";

/**
 * VR-4 — session-only Context continuity across Conversation switching. A
 * validated telemetry observation survives switching and returning from
 * browser memory (never a fetch), the compact card stays concise (no stale
 * label), and ONLY the popup labels it "Last observed <time>" until a fresh
 * live frame or explicit Refresh supersedes it. Store clears on unmount and
 * token change; never persisted.
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
const CONVERSATION_B = { ...CONVERSATION, id: "c2", title: "Conversation B", path: "collaboration/conversations/c2/index.md" };

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

function cardButton(agent: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label^="${agentDisplayName(agent)}:"]`) ?? null;
}

function cardShortText(agent: string): string | null {
  return cardButton(agent)?.querySelector(".context-card-state")?.textContent ?? null;
}

function popup(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

async function openPopup(agent: string): Promise<HTMLElement> {
  const card = cardButton(agent);
  if (card === null) throw new Error(`no card for ${agent}`);
  await act(async () => card.click());
  await flush();
  const dialog = popup();
  if (dialog === null) throw new Error("popup did not open");
  return dialog;
}

function popupRefresh(dialog: HTMLElement, agent: string): HTMLButtonElement {
  const button = dialog.querySelector<HTMLButtonElement>(`button[aria-label="Refresh context telemetry for ${agentDisplayName(agent)}"]`);
  if (button === null) throw new Error("no popup Refresh control");
  return button;
}

const OK_FRAME = {
  conversationId: "c1",
  agent: "dipu",
  runId: "run-0001",
  contextState: "ok",
  context: { tokens: 60000, contextWindow: 200000, percent: 30 },
  model: { provider: "anthropic", id: "claude-sonnet-4" },
};

beforeEach(() => {
  contextContinuityStore.clear();
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }, { name: "zai", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockImplementation(async (id: string) => (id === "c2" ? CONVERSATION_B : CONVERSATION));
  vi.mocked(fetchConversationTelemetry).mockReset();
  vi.mocked(attachConversation).mockReset().mockImplementation(async () => ({
    conversation: (window.location.hash.includes("c2") ? CONVERSATION_B : CONVERSATION),
    attached: true,
    gate: { ok: true, missing: [], malformed: [] },
  }));
  container = document.createElement("div");
  document.body.append(container);
  window.location.hash = "#conversation/c1";
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  window.location.hash = "";
  contextContinuityStore.clear();
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

async function switchTo(id: string): Promise<void> {
  await act(async () => {
    window.location.hash = `#conversation/${id}`;
  });
  await flush();
  await flush();
}

describe("ConversationNavigator VR-4 context continuity", () => {
  it("switch A→B→A rehydrates the compact Context card from memory WITHOUT any fetch", async () => {
    await mountNavigator();
    deliverTelemetry(OK_FRAME);
    await flush();
    expect(cardShortText("dipu")).toBe("30.00%");
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();

    // Away to c2 and back: rehydrated from the store, never a fetch.
    await switchTo("c2");
    await switchTo("c1");
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
    expect(cardShortText("dipu")).toBe("30.00%");
  });

  it("the modal labels rehydrated data 'Last observed <time>'; the compact card never shows a stale label", async () => {
    await mountNavigator();
    deliverTelemetry(OK_FRAME);
    await flush();
    await switchTo("c2");
    await switchTo("c1");

    // Compact card: concise, no restored wording.
    const card = cardButton("dipu")!;
    expect(card.textContent).not.toContain("Last observed");
    expect(cardShortText("dipu")).toBe("30.00%");

    const dialog = await openPopup("dipu");
    expect(dialog.textContent).toContain("Last observed");
    // Stable UTC HH:MM:SS format present.
    expect(dialog.textContent).toMatch(/Last observed\d{2}:\d{2}:\d{2} UTC/);
  });

  it("a fresh live frame removes the restored label; an explicit Refresh updates the store and removes the label", async () => {
    await mountNavigator();
    deliverTelemetry(OK_FRAME);
    await flush();
    await switchTo("c2");
    await switchTo("c1");
    // A fresh live frame supersedes the restored entry.
    deliverTelemetry({ ...OK_FRAME, context: { tokens: 123, contextWindow: 200000, percent: 0.06 } });
    await flush();
    expect(cardShortText("dipu")).toBe("0.06%");
    expect((await openPopup("dipu")).textContent).not.toContain("Last observed");
    await act(async () => popup()?.querySelector(".telemetry-popup-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    // Explicit Refresh is the only fetch; it updates the store and clears the label.
    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "live", contextState: "no_window" });
    const dialog2 = await openPopup("dipu");
    await act(async () => popupRefresh(dialog2, "dipu").click());
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(popup()?.textContent).not.toContain("Last observed");
  });

  it("the same agent in a different Conversation never leaks across conversations", async () => {
    await mountNavigator();
    deliverTelemetry(OK_FRAME); // c1/dipu -> 30.00%
    await flush();
    await switchTo("c2");
    // A DIFFERENT observation for c2/dipu.
    deliverTelemetry({ ...OK_FRAME, conversationId: "c2", context: { tokens: 999, contextWindow: 10000, percent: 9.99 } });
    await flush();
    expect(cardShortText("dipu")).toBe("9.99%");
    // Back to c1: the c1 observation returns, never c2's.
    await switchTo("c1");
    expect(cardShortText("dipu")).toBe("30.00%");
  });

  it("unmount clears the whole store; a token change also clears it", async () => {
    await mountNavigator();
    deliverTelemetry(OK_FRAME);
    await flush();
    expect(contextContinuityStore.listConversation("c1")).toHaveLength(1);
    // Token change (loss/handover) clears everything.
    await act(async () => {
      root.render(
        createElement(ConversationNavigator, {
          token: "t2",
          onUnauthorized: () => {},
          onValidated: () => {},
          onConversationsChanged: () => {},
        }),
      );
    });
    await flush();
    expect(contextContinuityStore.listConversation("c1")).toHaveLength(0);
  });
});

// --- VR-4 correction: complete immediate token-loss / typed-401 clearing ---
import { UnauthorizedError } from "../web/src/api.js";

describe("ConversationNavigator VR-4 immediate token-loss/401 clearing", () => {
  const onUnauthorized = vi.fn();

  beforeEach(() => {
    onUnauthorized.mockClear();
  });

  async function mountWithSpy(): Promise<void> {
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
  }

  it("an explicit Refresh 401 clears popup/store/live+restored cards synchronously and hands to the parent once", async () => {
    await mountWithSpy();
    deliverTelemetry(OK_FRAME);
    await flush();
    await switchTo("c2");
    await switchTo("c1");
    const dialog = await openPopup("dipu");
    expect(dialog.textContent).toContain("Last observed");

    vi.mocked(fetchConversationTelemetry).mockRejectedValueOnce(new UnauthorizedError());
    await act(async () => popupRefresh(dialog, "dipu").click());
    await flush();

    // Popup closed, store cleared, no live/restored facts remain rendered.
    expect(popup()).toBeNull();
    expect(contextContinuityStore.listConversation("c1")).toEqual([]);
    expect(cardShortText("dipu")).toBe("not sampled");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a Timeline stream 401 clears store/popup/live+restored synchronously even without a parent rerender", async () => {
    await mountWithSpy();
    deliverTelemetry(OK_FRAME);
    await flush();
    await switchTo("c2");
    await switchTo("c1");
    await openPopup("dipu");

    // The navigator must hand its OWN complete-clear helper to the Timeline;
    // invoking it must clear everything and forward to the parent.
    const timelineOnUnauthorized = timelineProps.onUnauthorized as (() => void) | undefined;
    if (timelineOnUnauthorized === undefined) throw new Error("timeline onUnauthorized not wired");
    await act(async () => timelineOnUnauthorized());

    expect(popup()).toBeNull();
    expect(contextContinuityStore.listConversation("c1")).toEqual([]);
    expect(cardShortText("dipu")).toBe("not sampled");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("an ordinary token change clears BOTH current live telemetry and restored presentation", async () => {
    await mountWithSpy();
    // Stage dipu as a RESTORED observation (switch away and back), then zai as
    // a LIVE observation so both presentation kinds coexist at token-change time.
    deliverTelemetry(OK_FRAME);
    await flush();
    await switchTo("c2");
    await switchTo("c1");
    expect(cardShortText("dipu")).toBe("30.00%");
    deliverTelemetry({ ...OK_FRAME, agent: "zai", runId: "run-zai", context: { tokens: 5, contextWindow: 100, percent: 5 } });
    await flush();
    expect(cardShortText("dipu")).toBe("30.00%"); // restored
    expect(cardShortText("zai")).toBe("5.00%"); // live

    await act(async () => {
      root.render(
        createElement(ConversationNavigator, {
          token: "t2",
          onUnauthorized,
          onValidated: () => {},
          onConversationsChanged: () => {},
        }),
      );
    });
    await flush();

    expect(contextContinuityStore.listConversation("c1")).toEqual([]);
    expect(cardShortText("dipu")).toBe("not sampled");
    expect(cardShortText("zai")).toBe("not sampled");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

// --- VR-4 final correction: token-loss clear must be pre-paint ---
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("VR-4 token-loss clear lifecycle placement", () => {
  it("the ordinary token-change Context clear is pre-paint (useLayoutEffect keyed on token)", async () => {
    const source = await readFile(join(process.cwd(), "web", "src", "ConversationNavigator.tsx"), "utf8");
    const marker = source.indexOf("an ordinary token change performs the SAME complete");
    expect(marker).toBeGreaterThan(-1);
    // The effect containing the clear must be a LAYOUT effect keyed exactly
    // on token, so a token update runs the clear synchronously before paint.
    const window = source.slice(marker, marker + 900);
    expect(window).toContain("useLayoutEffect(() => {");
    expect(window).toContain("}, [token]);");
    expect(window.indexOf("useEffect(() => {")).toBe(-1);
  });
});
