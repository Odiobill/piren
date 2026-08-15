// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationNavigator } from "../web/src/ConversationNavigator.js";
import { attachConversation, fetchConversation, fetchConversationAgents } from "../web/src/api.js";

/**
 * ADR-0044 Tracer B — component proof for the active Conversation tray: the
 * exact approval cards, the composer, and the details control render INSIDE
 * the bottom `.interaction-tray` OUTSIDE the `.conversation-history` scroll
 * host, and the approval card keeps its existing focus-on-arrival and native
 * keyboard semantics (its authority/request semantics are untouched).
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
  };
});

// The timeline is mocked so the test controls live frames exactly; the
// composer/modal are mocked to inert placeholders (their own suites cover
// their internals).
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

beforeEach(() => {
  vi.mocked(fetchConversationAgents).mockReset().mockResolvedValue({ agents: [{ name: "dipu", online: true }] });
  vi.mocked(fetchConversation).mockReset().mockResolvedValue(CONVERSATION);
  vi.mocked(attachConversation)
    .mockReset()
    .mockResolvedValue({ conversation: CONVERSATION, attached: true, gate: { ok: true, missing: [], malformed: [] } });
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

async function mountActiveNavigator(): Promise<void> {
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

describe("ConversationNavigator Tracer B tray (component)", () => {
  it("the active surface renders history host then tray; timeline inside the host; composer/details inside the tray", async () => {
    await mountActiveNavigator();
    const history = container.querySelector(".conversation-history");
    const tray = container.querySelector(".interaction-tray");
    expect(history).not.toBeNull();
    expect(tray).not.toBeNull();
    // The durable timeline renders inside the history scroll host.
    expect(history?.querySelector(".mock-timeline")).not.toBeNull();
    // The tray carries the composer + details controls, never the timeline.
    expect(tray?.querySelector(".mock-composer")).not.toBeNull();
    expect(tray?.querySelector(".conversation-details-toggle")).not.toBeNull();
    expect(tray?.querySelector(".mock-timeline")).toBeNull();
    // DOM order: history region before the tray.
    expect(
      history!.compareDocumentPosition(tray!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The history region is the named keyboard-accessible region.
    expect(history?.getAttribute("role")).toBe("region");
    expect(history?.getAttribute("aria-label")).toBe("Conversation history");
    expect(history?.getAttribute("tabindex")).toBe("0");
  });

  it("a pending approval card renders inside the tray with its existing focus-on-arrival and native keyboard controls", async () => {
    await mountActiveNavigator();
    const onApproval = timelineProps.onApproval as (approval: unknown) => void;
    expect(typeof onApproval).toBe("function");
    await act(async () => {
      onApproval({ conversationId: "c1", agent: "dipu", requestId: "req-1", method: "confirm", payload: { title: "Proceed?" } });
    });
    // The card lives INSIDE the interaction tray (never in the transcript).
    const card = container.querySelector(".interaction-tray .approval-card");
    expect(card).not.toBeNull();
    expect(container.querySelector(".conversation-history .approval-card")).toBeNull();
    // Existing focus behavior: the Confirm action receives focus on arrival.
    const confirm = card?.querySelector<HTMLButtonElement>(".button-primary");
    expect(confirm).not.toBeNull();
    expect(document.activeElement).toBe(confirm);
    // Native keyboard operation: real buttons, not disabled.
    expect(confirm?.tagName).toBe("BUTTON");
    expect(confirm?.disabled).toBe(false);
    const cancel = Array.from(card?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Cancel");
    expect(cancel?.disabled).toBe(false);
  });
});
