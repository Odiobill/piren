// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { ConversationWorkCard } from "../web/src/conversation-activity.js";

/**
 * VR-3 — selected active Conversation history-region activity cards now carry
 * a bounded transient streamed tail (plain text only) and safe sanitized tool
 * lines, while keeping exact agent identity, working/typing state, the scoped
 * abort affordance, and every clearing path. Durable evidence is authoritative;
 * cards are never reconstructed from history.
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
  ConversationComposer: (props: Record<string, unknown>) =>
    createElement("div", { className: "mock-composer" }, createElement("textarea", { id: `conversation-message-${props.conversationId as string}` })),
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

function deliverWorkCards(cards: ConversationWorkCard[]): void {
  const cb = timelineProps.onWorkCards as ((cards: ConversationWorkCard[]) => void) | undefined;
  if (cb === undefined) throw new Error("onWorkCards not wired");
  act(() => cb(cards));
}

function deliverActivity(runs: Array<{ runId: string; agent: string; phase: "working" | "typing" }>): void {
  const cb = timelineProps.onActivityChange as ((runs: unknown) => void) | undefined;
  if (cb === undefined) throw new Error("onActivityChange not wired");
  act(() => cb(runs));
}

function card(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".activity-card");
}

beforeEach(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation).mockReset().mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
  vi.mocked(approveConversationApproval).mockReset().mockResolvedValue(undefined);
  vi.mocked(abortConversationRun).mockReset().mockResolvedValue({ status: "cancelled" });
  container = document.createElement("div");
  document.body.append(container);
  window.location.hash = "#conversation/c1";
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  window.location.hash = "";
});

async function renderNavigator(): Promise<void> {
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

describe("ConversationNavigator VR-3 work cards", () => {
  it("renders the bounded tail as plain text and the safe tool lines, with the exact scoped Abort", async () => {
    await renderNavigator();
    // A live active run is reported by the (mocked) timeline.
    deliverActivity([{ runId: "r1", agent: "dipu", phase: "typing" }]);
    deliverWorkCards([
      { runId: "r1", agent: "dipu", phase: "typing", textTail: "**not bold** <script>alert(1)</script>", tools: [{ name: "vault_read", status: "started" }, { name: "bash", status: "failed" }] },
    ]);
    await flush();

    const el = card();
    expect(el).not.toBeNull();
    // Tail is plain text: no <strong>/<script>/<a> element is created.
    const tail = el!.querySelector(".activity-card-tail");
    expect(tail).not.toBeNull();
    expect(tail!.textContent).toBe("**not bold** <script>alert(1)</script>");
    expect(tail!.querySelector("strong, script, a, code, em")).toBeNull();
    // Tool lines render name + exact status only.
    const toolLines = Array.from(el!.querySelectorAll(".activity-card-tools li")).map((n) => n.textContent);
    expect(toolLines).toEqual(["vault_read — started", "bash — failed"]);
    // Agent identity + truthful state still present.
    expect(el!.textContent).toContain("dipu");
    expect(el!.textContent).toContain("typing");
    // Exact scoped abort still works.
    const abort = el!.querySelector<HTMLButtonElement>(".transient-run-abort");
    expect(abort).not.toBeNull();
    await act(async () => {
      abort!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(abortConversationRun).toHaveBeenCalledWith("c1", "dipu", "t");
  });

  it("no content or status announces: the announcement region reports only phase, never tail/tool text", async () => {
    await renderNavigator();
    deliverActivity([{ runId: "r1", agent: "dipu", phase: "typing" }]);
    deliverWorkCards([
      { runId: "r1", agent: "dipu", phase: "typing", textTail: "secret tail", tools: [{ name: "vault_read", status: "started" }] },
    ]);
    await flush();
    const announcement = container.querySelector<HTMLElement>('[data-activity-announcement="true"]');
    expect(announcement?.textContent ?? "").not.toContain("secret tail");
    expect(announcement?.textContent ?? "").not.toContain("vault_read");
  });

  it("clears the cards when the transient work-card set empties (durable terminal / selection / stream loss)", async () => {
    await renderNavigator();
    deliverActivity([{ runId: "r1", agent: "dipu", phase: "working" }]);
    deliverWorkCards([{ runId: "r1", agent: "dipu", phase: "working", textTail: "x", tools: [] }]);
    await flush();
    expect(card()).not.toBeNull();
    deliverActivity([]);
    deliverWorkCards([]);
    await flush();
    expect(card()).toBeNull();
  });

  it("read-only/archived inspection renders no work cards", async () => {
    vi.mocked(fetchConversation).mockResolvedValue({ ...CONVERSATION, status: "archived" });
    await renderNavigator();
    // Even a hostile callback payload cannot materialize a card here.
    deliverWorkCards([{ runId: "r1", agent: "dipu", phase: "typing", textTail: "should not render", tools: [] }]);
    await flush();
    expect(card()).toBeNull();
  });
});
