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
 * T6 — Workbench per-agent session-only telemetry indicator and explicit
 * refresh (workbench-task-handoff-and-agent-telemetry-contract §7 T6). The
 * compact text-first row lives in the ACTIVE interaction-tray as its own
 * named sibling; refresh is explicit-only (one click → one exact
 * authenticated GET); no mount/selection/SSE/timer fetch, no retries, no
 * storage, no red action-badge semantics.
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

function telemetryRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-telemetry-row");
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

describe("T6 telemetry tray row", () => {
  it("renders one named tray row above composer controls with per-agent refresh controls and no telemetry text before any frame/refresh", async () => {
    await mountNavigator();
    const row = telemetryRow();
    expect(row).not.toBeNull();
    expect(row?.parentElement?.classList.contains("interaction-tray")).toBe(true);
    expect(container.querySelector(".composer-action-row .conversation-telemetry-row")).toBeNull();
    expect(trayChildOrder()).toEqual(["conversation-telemetry-row", "composer-action-row"]);
    // Absence of a live frame remains absence: labels + refresh controls, no invented state.
    expect(row?.textContent).toContain("dipu");
    expect(row?.textContent).toContain("zai");
    expect(row?.textContent).not.toContain("no live session");
    expect(row?.querySelector('[aria-label="Refresh context telemetry for dipu"]')).not.toBeNull();
    expect(row?.querySelector('[aria-label="Refresh context telemetry for zai"]')).not.toBeNull();
    // No red/action-required badge semantics.
    expect(row?.querySelector(".badge, .status-badge, [data-attention]")).toBeNull();
    // No fetch happened on mount/selection.
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("a valid live SSE frame updates only the matching agent with the compact text line", async () => {
    await mountNavigator();
    await act(async () => deliverTelemetry(OK_FRAME));
    await flush();
    const row = telemetryRow();
    expect(row?.textContent).toContain("dipu · 60.0k / 200.0k context · 30% · auto-compaction on · anthropic/claude-sonnet-4 · thinking high");
    expect(row?.textContent).not.toContain("zai ·");
    const line = row?.querySelector(".telemetry-text");
    expect(line?.getAttribute("aria-label")).toContain("30 percent");
    // SSE receipt triggered no fetch.
    expect(vi.mocked(fetchConversationTelemetry)).not.toHaveBeenCalled();
  });

  it("a post_compaction_pending frame renders truthful unavailable text and never a fabricated percent", async () => {
    await mountNavigator();
    await act(async () =>
      deliverTelemetry({ conversationId: "c1", agent: "zai", runId: "run-0002", contextState: "post_compaction_pending", context: { tokens: null, contextWindow: 200000, percent: null } }),
    );
    await flush();
    const row = telemetryRow();
    expect(row?.textContent).toContain("zai · context usage temporarily unavailable after compaction");
    expect(row?.textContent).not.toContain("zai · 0%");
  });

  it("explicit refresh: one click → one exact authenticated GET; result renders; live and no-live responses", async () => {
    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "live", contextState: "no_window" });
    await mountNavigator();
    const button = telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]');
    await act(async () => {
      button?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(telemetryRow()?.textContent).toContain("dipu · no context window information");

    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "no_live_session" });
    await act(async () => {
      telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]')?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(2);
    expect(telemetryRow()?.textContent).toContain("dipu · no live session");
  });

  it("401 refresh routes through onUnauthorized; bounded failure shows a truthful error and never relabels stale values", async () => {
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

    vi.mocked(fetchConversationTelemetry).mockRejectedValueOnce(new UnauthorizedError());
    await act(async () => {
      telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]')?.click();
    });
    await flush();
    expect(onUnauthorized).toHaveBeenCalled();

    vi.mocked(fetchConversationTelemetry).mockRejectedValueOnce(new Error("conversation telemetry HTTP 500"));
    await act(async () => {
      telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]')?.click();
    });
    await flush();
    // The prior good value stays (not relabeled as fresh) and the failure is visible.
    expect(telemetryRow()?.textContent).toContain("60.0k / 200.0k context · 30%");
    expect(telemetryRow()?.querySelector('[role="alert"]')?.textContent).toContain("500");
  });

  it("tray order with approvals/activity present: approval cards, activity row, telemetry row, composer controls", async () => {
    await mountNavigator();
    const onApproval = timelineProps.onApproval as (approval: unknown) => void;
    const onActivityChange = timelineProps.onActivityChange as (runs: unknown) => void;
    await act(async () =>
      onApproval({ conversationId: "c1", agent: "dipu", requestId: "req-1", method: "confirm", payload: { title: "Proceed?" } }),
    );
    await act(async () => onActivityChange([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    expect(trayChildOrder()).toEqual(["approval-cards", "conversation-activity-row", "conversation-telemetry-row", "composer-action-row"]);
  });
});

describe("T6 fetchConversationTelemetry (narrow T4 adapter)", () => {
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

describe("T6 cross-selection refresh race guard (correction)", () => {
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

  it("a refresh resolving after the selection changed is fully inert; a same-selection refresh applies exactly once", async () => {
    let resolveA: ((value: unknown) => void) | undefined;
    vi.mocked(fetchConversationTelemetry).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    await mountNavigator();

    // Start an unresolved refresh for Conversation A's dipu.
    await act(async () => {
      telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]')?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledWith("c1", "dipu", "t");
    expect(telemetryRow()?.textContent).toContain("Refreshing…");

    // Switch to Conversation B (fresh manifest + attach for c2).
    vi.mocked(fetchConversation).mockImplementation(async (id: string) => (id === "c2" ? CONVERSATION_B : CONVERSATION));
    vi.mocked(attachConversation).mockResolvedValue({ conversation: CONVERSATION_B, attached: true, gate: { ok: true, missing: [], malformed: [] } });
    await act(async () => {
      window.location.hash = "#conversation/c2";
    });
    await flush();
    await flush();
    expect(telemetryRow()?.textContent).toContain("dipu");
    expect(telemetryRow()?.textContent).not.toContain("Refreshing…");

    // A's refresh resolves late: fully inert for B — no telemetry, no error,
    // no busy state, no second request.
    await act(async () => {
      resolveA?.({ sessionState: "live", contextState: "ok", context: { tokens: 60000, contextWindow: 200000, percent: 30 } });
    });
    await flush();
    const rowB = telemetryRow();
    expect(rowB?.textContent).not.toContain("60.0k / 200.0k context");
    expect(rowB?.textContent).not.toContain("Refreshing…");
    expect(rowB?.querySelector('[role="alert"]')).toBeNull();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);

    // A same-selection refresh on B still applies exactly once.
    vi.mocked(fetchConversationTelemetry).mockResolvedValue({ sessionState: "live", contextState: "no_window" });
    await act(async () => {
      telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]')?.click();
    });
    await flush();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenLastCalledWith("c2", "dipu", "t");
    expect(telemetryRow()?.textContent).toContain("dipu · no context window information");
  });
});

describe("T6 commit-window race guard (final correction)", () => {
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
    expect(source.slice(boundary, bump + 200)).toContain("[surfaceKey]");
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
    await act(async () => {
      telemetryRow()?.querySelector<HTMLButtonElement>('[aria-label="Refresh context telemetry for dipu"]')?.click();
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

    const rowB = telemetryRow();
    expect(rowB).not.toBeNull();
    expect(rowB?.textContent).toContain("dipu");
    expect(rowB?.textContent).not.toContain("60.0k / 200.0k context");
    expect(rowB?.textContent).not.toContain("Refreshing…");
    expect(rowB?.querySelector('[role="alert"]')).toBeNull();
    expect(vi.mocked(fetchConversationTelemetry)).toHaveBeenCalledTimes(1);
  });
});
