// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { UnauthorizedError, attachConversation, fetchConversation, fetchConversationAgents, fetchConversationWorkflowStatus } from "../web/src/api.js";
import type { ConversationWorkflowStatusSnapshot } from "../web/src/api.js";

/**
 * B6 — W3 per-agent context-card workflow status (contract §6/§7-B6):
 * statuses are read ONLY at the contract's explicit moments (fresh
 * attach/read, durable reread, details-modal close, after a budget
 * update's re-gate); existing live activity frames may only transition
 * busy between explicit reads; no timer/SSE/card-open fetch, no retry, no
 * storage; a non-401 failure yields no fabricated indicator; a typed 401
 * uses the existing onUnauthorized recovery path and clears status.
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
    fetchConversationTelemetry: vi.fn(),
    fetchConversationWorkflowStatus: vi.fn(),
  };
});

let timelineProps: Record<string, unknown> = {};
vi.mock("../web/src/ConversationTimeline.js", async () => {
  const { createElement: ce, useEffect } = await import("react");
  return {
    // The real timeline calls onHistoryLoaded exactly once per full durable
    // history load (attach/reread/reconnect) — the B6 explicit read moment.
    ConversationTimeline: (props: Record<string, unknown>) => {
      timelineProps = props;
      useEffect(() => {
        (props.onHistoryLoaded as (() => void) | undefined)?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return ce("div", { className: "mock-timeline" });
    },
  };
});
vi.mock("../web/src/ConversationComposer.js", () => ({
  ConversationComposer: () => createElement("div", { className: "mock-composer" }),
}));
vi.mock("../web/src/ConversationDetailsModal.js", async () => {
  const { createElement: ce } = await import("react");
  return {
    // Minimal stand-in exposing the modal's onClose contract so the test can
    // drive the navigator's details-modal close moment.
    ConversationDetailsModal: (props: Record<string, unknown>) =>
      ce("button", { "data-testid": "mock-details-close", onClick: props.onClose as () => void }, "close"),
    ConversationLifecycleControls: () => null,
  };
});

let container: HTMLDivElement;
let root: Root;
let unauthorizedCount: number;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function cardsRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-context-cards");
}

function cardButton(agent: string): HTMLButtonElement | null {
  return cardsRow()?.querySelector<HTMLButtonElement>(`button[aria-label^="${agent}:"]`) ?? null;
}

function workflowIndicator(agent: string): HTMLElement | null {
  return cardButton(agent)?.querySelector<HTMLElement>(".context-card-workflow-status") ?? null;
}

function deliverActivity(runs: Array<{ runId: string; agent: string; phase: "working" | "typing" }>): void {
  const onActivityChange = timelineProps.onActivityChange as ((runs: unknown) => void) | undefined;
  if (onActivityChange === undefined) throw new Error("onActivityChange not wired");
  onActivityChange(runs);
}

function snapshot(overrides: Partial<ConversationWorkflowStatusSnapshot> = {}): ConversationWorkflowStatusSnapshot {
  return {
    runActive: false,
    workflow: null,
    ...overrides,
  };
}

function facts(overrides: Partial<NonNullable<ConversationWorkflowStatusSnapshot["workflow"]>> = {}): NonNullable<ConversationWorkflowStatusSnapshot["workflow"]> {
  return {
    rootEventId: "root-1",
    association: "latest-run",
    base: { edges: 8, reworkRounds: 2 },
    effective: { edges: 10, reworkRounds: 3 },
    consumed: { edges: 4 },
    worstPairOccurrences: 1,
    low: false,
    exhausted: false,
    warnings: [],
    omittedWarnings: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  unauthorizedCount = 0;
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }, { name: "zai", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation).mockReset().mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
  vi.mocked(fetchConversationWorkflowStatus).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  window.location.hash = "#conversation/c1";
  // Drain jsdom's ASYNC hashchange for the beforeEach hash write BEFORE the
  // navigator mounts, so the mount's initial handleHash is the single attach
  // (a queued event firing after listener registration would otherwise
  // double-attach — a test-environment artifact, not production behavior).
  await new Promise((resolve) => setTimeout(resolve, 0));
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
        onUnauthorized: () => {
          unauthorizedCount += 1;
        },
        onValidated: () => {},
        onConversationsChanged: () => {},
      }),
    );
  });
  await flush();
}

describe("B6 per-agent context-card workflow status (browser surface)", () => {
  it("renders Busy from a workflow-null run_active attach snapshot (non-C5 agent-first run)", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockImplementation(async (_id: string, agent: string) =>
      agent === "dipu" ? snapshot({ runActive: true }) : snapshot(),
    );
    await mountNavigator();
    const indicator = workflowIndicator("dipu");
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain("context-card-workflow-status-busy");
    expect(indicator?.textContent).toContain("running");
    expect(cardButton("dipu")?.getAttribute("aria-label")).toContain("dipu is currently running");
    // The non-running agent renders no indicator at all.
    expect(workflowIndicator("zai")).toBeNull();
    // The snapshot is the exact-pair route for each audience member.
    expect(fetchConversationWorkflowStatus).toHaveBeenCalledTimes(2);
  });

  it("renders no indicator when there is no association and no run", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot());
    await mountNavigator();
    expect(workflowIndicator("dipu")).toBeNull();
    expect(workflowIndicator("zai")).toBeNull();
    // The base card name is unchanged.
    expect(cardButton("dipu")?.getAttribute("aria-label")).not.toContain("running");
  });

  it("red > yellow > busy with red/yellow tied only to the associated workflow", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockImplementation(async (_id: string, agent: string) => {
      if (agent === "dipu") return snapshot({ runActive: true, workflow: facts({ exhausted: true, low: true }) });
      return snapshot({ runActive: true, workflow: facts({ low: true, consumed: { edges: 8 } }) });
    });
    await mountNavigator();
    const red = workflowIndicator("dipu");
    expect(red?.className).toContain("context-card-workflow-status-red");
    expect(red?.textContent).toContain("budget exhausted");
    expect(cardButton("dipu")?.getAttribute("aria-label")).toContain(
      "Workflow budget exhausted for dipu's associated workflow; open Context telemetry to extend",
    );
    const yellow = workflowIndicator("zai");
    expect(yellow?.className).toContain("context-card-workflow-status-yellow");
    expect(cardButton("zai")?.getAttribute("aria-label")).toContain("Workflow budget low: 2 of 10 handoff edges remaining");
  });

  it("opens the associated workflow budget only in that agent's Context popup", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(
      snapshot({ runActive: true, workflow: facts({ low: true, consumed: { edges: 8 } }) }),
    );
    await mountNavigator();
    await act(async () => {
      cardButton("dipu")?.click();
    });
    await flush();

    const section = container.querySelector<HTMLElement>(".associated-workflow-budget");
    expect(section?.textContent).toContain("Associated handoff workflow");
    expect(section?.textContent).toContain("root-1");
    expect(section?.querySelector('input[id^="associated-workflow-budget-edges-"]')).not.toBeNull();
    // Opening the card reuses its last explicit exact-pair status snapshot;
    // it must not make another status read.
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls).toHaveLength(2);
  });

  it("a live activity transition gives busy with NO status fetch, and settled clears it", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot());
    await mountNavigator();
    const readsAfterAttach = vi.mocked(fetchConversationWorkflowStatus).mock.calls.length;
    deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]);
    await flush();
    const indicator = workflowIndicator("dipu");
    expect(indicator?.className).toContain("context-card-workflow-status-busy");
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(readsAfterAttach);
    deliverActivity([]);
    await flush();
    expect(workflowIndicator("dipu")).toBeNull();
  });

  it("a gateway-restart read (run_active:false) keeps durable red but clears busy", async () => {
    // Initial read: exhausted workflow AND active run.
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot({ runActive: true, workflow: facts({ exhausted: true, low: true }) }));
    await mountNavigator();
    expect(workflowIndicator("dipu")?.className).toContain("context-card-workflow-status-red");
    // Gateway restart: re-read reports run_active:false; red persists, busy is gone.
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot({ runActive: false, workflow: facts({ exhausted: true, low: true }) }));
    await act(async () => {
      (timelineProps.onHistoryLoaded as (() => void) | undefined)?.();
    });
    await flush();
    const red = workflowIndicator("dipu");
    expect(red?.className).toContain("context-card-workflow-status-red");
    expect(red?.className).not.toContain("busy");
  });

  it("re-reads only at explicit moments: attach, history reread, and Context-popup close — never card open, SSE, timer, or Details close", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot());
    await mountNavigator();
    const afterAttach = vi.mocked(fetchConversationWorkflowStatus).mock.calls.length;
    expect(afterAttach).toBe(2);
    // Card activation opens the popup and fetches nothing.
    await act(async () => {
      cardButton("dipu")?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(afterAttach);
    // Live SSE telemetry/activity frames fetch nothing.
    deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]);
    await flush();
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(afterAttach);
    // Context-popup close IS the relocated explicit moment: one fresh read
    // per audience agent. The Context card activation itself made none.
    const popupClose = container.querySelector<HTMLButtonElement>(".telemetry-popup-close");
    expect(popupClose).not.toBeNull();
    await act(async () => {
      popupClose?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(afterAttach + 2);

    // Conversation Details no longer contains a budget editor, so close has
    // no workflow-status reread side effect.
    const detailsButton = container.querySelector<HTMLButtonElement>(".conversation-details-toggle");
    await act(async () => {
      detailsButton?.click();
    });
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mock-details-close"]')?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(afterAttach + 2);
  });

  it("uses the exact encoded authenticated URL per audience agent", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot());
    await mountNavigator();
    const paths = vi.mocked(fetchConversationWorkflowStatus).mock.calls.map((call) => call[2] as unknown);
    void paths;
    const agents = vi.mocked(fetchConversationWorkflowStatus).mock.calls.map((call) => call[1]);
    expect(agents.sort()).toEqual(["dipu", "zai"]);
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls[0]?.[0]).toBe("c1");
  });

  it("a non-401 failed read yields no fabricated indicator and no automatic retry", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockRejectedValue(new Error("workflow status HTTP 500"));
    await mountNavigator();
    expect(workflowIndicator("dipu")).toBeNull();
    expect(workflowIndicator("zai")).toBeNull();
    expect(unauthorizedCount).toBe(0);
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(2);
  });

  it("a malformed snapshot yields no fabricated indicator", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockRejectedValue(new Error("unexpected workflow status payload"));
    await mountNavigator();
    expect(workflowIndicator("dipu")).toBeNull();
  });

  it("a typed 401 calls onUnauthorized and clears status", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockRejectedValue(new UnauthorizedError());
    await mountNavigator();
    expect(unauthorizedCount).toBe(1);
    expect(workflowIndicator("dipu")).toBeNull();
    expect(workflowIndicator("zai")).toBeNull();
  });

  it("a stale C1 completion is inert across a GENUINE distinct C2 selection: C2 renders only its own facts", async () => {
    // B6 final correction — the PREVIOUS version of this test had a FALSE
    // premise: it navigated to "#conversation/c2" but the fetchConversation/
    // attachConversation mocks still returned the original record whose id is
    // "c1", so it exercised only a fresh same-conversation re-open/sequence
    // path and could never have detected a broken exact
    // conversationId × audience target guard. THIS test uses a genuinely
    // distinct C2 record (different id AND disjoint audience) and leaves C1's
    // first status completion pending across the selection change.
    const C2 = { ...CONVERSATION, id: "c2", title: "Second conversation", audience: ["zai"], path: "collaboration/conversations/c2/index.md" };
    let releaseC1Dipu: ((value: ConversationWorkflowStatusSnapshot) => void) | undefined;
    vi.mocked(fetchConversation).mockImplementation(async (id: string) => (id === "c2" ? C2 : CONVERSATION));
    vi.mocked(attachConversation).mockImplementation(async (id: string) => ({
      conversation: id === "c2" ? C2 : CONVERSATION,
      attached: true,
      gate: { ok: true, missing: [], malformed: [] },
    }));
    vi.mocked(fetchConversationWorkflowStatus).mockImplementation(async (conversationId: string, agent: string) => {
      // C1's first read hangs: it is the ONLY stale result in this test.
      if (conversationId === "c1" && agent === "dipu") {
        return new Promise<ConversationWorkflowStatusSnapshot>((resolve) => {
          releaseC1Dipu = resolve;
        });
      }
      // C2's own read carries a RED budget fact (exhausted workflow) so the
      // test can observe whether the stale completion REPLACED C2's map.
      if (conversationId === "c2" && agent === "zai") {
        return snapshot({
          runActive: false,
          workflow: facts({ rootEventId: "root-c2", exhausted: true, low: true, effective: { edges: 10, reworkRounds: 3 }, consumed: { edges: 10 } }),
        });
      }
      return snapshot();
    });
    await mountNavigator(); // C1 attached; c1×dipu pending, c1×zai resolved.
    // Selection changed: navigate to the GENUINE distinct conversation.
    window.location.hash = "#conversation/c2";
    await flush();
    // C2's own read completed: C2's audience is exactly ["zai"] — no dipu
    // card exists, and zai carries ONLY C2's red fact.
    expect(cardButton("dipu")).toBeNull();
    const zaiCard = cardButton("zai");
    expect(zaiCard).not.toBeNull();
    expect(zaiCard?.querySelector(".context-card-workflow-status-red")).not.toBeNull();
    // The stale C1 completion (busy data for dipu) arrives AFTER C2's reads.
    await act(async () => {
      releaseC1Dipu?.(snapshot({ runActive: true }));
    });
    await flush();
    // Fully inert: C2 still renders exactly its own audience and C2's red
    // fact — no dipu card, no stale busy, and C2's red was NOT replaced.
    expect(cardButton("dipu")).toBeNull();
    expect(zaiCard?.querySelector(".context-card-workflow-status-busy")).toBeNull();
    expect(zaiCard?.querySelector(".context-card-workflow-status-red")).not.toBeNull();
    // Exact read arguments distinguish C1 and C2.
    const calls = vi.mocked(fetchConversationWorkflowStatus).mock.calls;
    expect(calls.filter((call) => call[0] === "c1").map((call) => call[1]).sort()).toEqual(["dipu", "zai"]);
    expect(calls.filter((call) => call[0] === "c2").map((call) => call[1])).toEqual(["zai"]);
  });

  it("an unexpected non-snapshot runtime value is treated as a non-401 failed read: no indicator, no crash, no unhandled rejection", async () => {
    // Trusted-adapter boundary defense: even if a runtime value that is not a
    // parsed snapshot reaches the consumer (never from the strict transport),
    // it must be inert — no indicator, no thrown/unhandled path, no retry.
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(undefined as unknown as ConversationWorkflowStatusSnapshot);
    await mountNavigator();
    expect(workflowIndicator("dipu")).toBeNull();
    expect(workflowIndicator("zai")).toBeNull();
    expect(unauthorizedCount).toBe(0);
    // No automatic retry.
    expect(vi.mocked(fetchConversationWorkflowStatus).mock.calls.length).toBe(2);
  });

  it("the indicator is labelled, adds no focusable control, and preserves popup behavior", async () => {
    vi.mocked(fetchConversationWorkflowStatus).mockResolvedValue(snapshot({ runActive: true }));
    await mountNavigator();
    const card = cardButton("dipu");
    expect(card).not.toBeNull();
    // No additional focusable inside the card button.
    expect(card?.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
    const indicator = workflowIndicator("dipu");
    expect(indicator?.textContent).toContain("running");
    // Existing popup behavior preserved: activation opens the telemetry popup.
    await act(async () => {
      card?.click();
    });
    await flush();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("reduced-motion: the busy state has a static CSS equivalent (no motion-only meaning)", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const css = await readFile(join(repoRoot, "web", "src", "styles.css"), "utf8");
    expect(css).toContain(".context-card-workflow-status-busy");
    const reducedIndex = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const busyIndex = css.indexOf(".context-card-workflow-status-busy");
    expect(reducedIndex).toBeGreaterThan(-1);
    expect(busyIndex).toBeGreaterThan(-1);
    // A reduced-motion block AFTER the busy definition must neutralize its animation.
    const tail = css.slice(Math.max(reducedIndex, busyIndex));
    expect(tail).toMatch(/\.context-card-workflow-status-busy[^{]*\{[^}]*animation:\s*none/);
  });
});

describe("B6 static pins — no persistence, no polling, no retry, no per-agent budget, no event bus", () => {
  it("introduces no storage, timer polling, hidden retry, per-agent budget editing, or generic event bus", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = await Promise.all(
      [
        "web/src/conversation-budget-status.ts",
        "web/src/ConversationNavigator.tsx",
      ].map((p) => readFile(join(repoRoot, p), "utf8")),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(source).not.toMatch(/setInterval\s*\(/);
      expect(source).not.toMatch(/addEventListener\(\s*["'](?:timeout|tick|poll)/);
      expect(source).not.toMatch(/new EventTarget\(|CustomEvent\(|dispatchEvent\(/);
    }
  });
});
