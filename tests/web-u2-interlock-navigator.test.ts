// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { abortConversationRun, attachConversation, fetchConversation, fetchConversationAgents } from "../web/src/api.js";

/**
 * U2 — selected-Conversation composer interlock derivation (amendment §6.2):
 * the navigator computes `interlocked` from broker-authoritative state only
 * (an active run via activity, or a steward-scoped pending approval), passes
 * it with a specific reason to the composer, and the U1 focused-abort
 * removal fallback targets the history container when the composer is
 * interlocked (never the read-only composer). No new route/SSE/transport.
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
let composerProps: Record<string, unknown> = {};
vi.mock("../web/src/ConversationTimeline.js", () => ({
  ConversationTimeline: (props: Record<string, unknown>) => {
    timelineProps = props;
    return createElement("div", { className: "mock-timeline" });
  },
}));
vi.mock("../web/src/ConversationComposer.js", () => ({
  ConversationComposer: (props: Record<string, unknown>) => {
    composerProps = props;
    const cid = props.conversationId as string;
    return createElement(
      "div",
      { className: "mock-composer" },
      createElement("textarea", { id: `conversation-message-${cid}`, readOnly: props.interlocked === true }),
      props.interlocked === true
        ? createElement("p", { id: `conversation-message-${cid}-interlock-reason` }, props.interlockReason as string)
        : null,
    );
  },
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

function deliverApproval(agent = "dipu"): void {
  const onApproval = timelineProps.onApproval as (approval: unknown) => void;
  onApproval({ conversationId: "c1", agent, requestId: "req-1", method: "confirm", payload: { title: "Proceed?" } });
}

function composerTextarea(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>('textarea[id^="conversation-message-"]');
  if (el === null) throw new Error("composer textarea missing");
  return el;
}

function historyRegion(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".conversation-history");
}

beforeEach(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }, { name: "zai", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation)
    .mockReset()
    .mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
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

describe("U2 composer interlock derivation (navigator)", () => {
  it("derives interlock from an active broker run and passes the working reason to the composer", async () => {
    await mountNavigator();
    expect(composerProps.interlocked).toBe(false);
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    expect(composerProps.interlocked).toBe(true);
    expect(composerProps.interlockReason).toBe("dipu is working…");
    expect(composerTextarea().readOnly).toBe(true);
    expect(container.querySelector("#conversation-message-c1-interlock-reason")?.textContent).toBe("dipu is working…");
  });

  it("derives interlock from a pending approval and passes the approval reason (approval precedence)", async () => {
    await mountNavigator();
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await act(async () => deliverApproval("dipu"));
    await flush();
    expect(composerProps.interlocked).toBe(true);
    expect(composerProps.interlockReason).toBe("Approval required for dipu");
    expect(container.querySelector("#conversation-message-c1-interlock-reason")?.textContent).toBe("Approval required for dipu");
  });

  it("clears interlock when both the active run and approval disappear", async () => {
    await mountNavigator();
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "typing" }]));
    await flush();
    expect(composerProps.interlocked).toBe(true);
    await act(async () => deliverActivity([]));
    await flush();
    expect(composerProps.interlocked).toBe(false);
    expect(composerTextarea().readOnly).toBe(false);
  });

  it("read-only inspection has no interlock (the composer is not rendered at all)", async () => {
    vi.mocked(attachConversation).mockResolvedValue({
      attached: false,
      error: "agent 'dipu' is not runnable",
      gate: { ok: false, missing: ["dipu"], malformed: [] },
    });
    await mountNavigator();
    await flush();
    expect(container.querySelector(".attach-banner")).not.toBeNull();
    expect(container.querySelector(".mock-composer")).toBeNull();
  });
});

describe("U1 focused-abort removal fallback (U2 amendment)", () => {
  it("when the composer stays interlocked, focus falls back to the history container (never the read-only composer)", async () => {
    await mountNavigator();
    await act(async () =>
      deliverActivity([
        { runId: "r1", agent: "dipu", phase: "working" },
        { runId: "r2", agent: "zai", phase: "working" },
      ]),
    );
    await flush();
    const abort = container.querySelector<HTMLButtonElement>('[aria-label="Abort dipu\'s current work"]');
    expect(abort).toBeDefined();
    abort?.focus();
    expect(document.activeElement).toBe(abort);

    // Only dipu's card disappears; zai is still working, so the composer is
    // still interlocked.
    await act(async () => deliverActivity([{ runId: "r2", agent: "zai", phase: "working" }]));
    await flush();
    expect(document.activeElement).toBe(historyRegion());
    expect(document.activeElement).not.toBe(composerTextarea());
  });

  it("when the composer is no longer interlocked, focus returns to the composer (existing U1 behavior)", async () => {
    await mountNavigator();
    await act(async () => deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]));
    await flush();
    const abort = container.querySelector<HTMLButtonElement>('[aria-label="Abort dipu\'s current work"]');
    abort?.focus();
    await act(async () => deliverActivity([]));
    await flush();
    expect(document.activeElement?.id).toBe("conversation-message-c1");
  });
});
