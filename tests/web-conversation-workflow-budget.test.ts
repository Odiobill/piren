// @vitest-environment jsdom
// W5b removal proof: Conversation Details owns only Conversation metadata,
// rename, and lifecycle controls. Associated workflow budgets are shown only
// through the exact agent's Context telemetry popup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationDetailsModal } from "../web/src/ConversationDetailsModal.js";
import type { ConversationRecord } from "../web/src/conversations.js";

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, fetchConversationWorkflowBudgets: vi.fn() };
});
import { fetchConversationWorkflowBudgets } from "../web/src/api.js";

const CONVERSATION: ConversationRecord = {
  id: "c1",
  title: "Budget conversation",
  path: "collaboration/conversations/c1/index.md",
  createdBy: "steward",
  audience: ["zai"],
  status: "open",
  created: "2026-09-04T00:00:00.000Z",
  updated: "2026-09-04T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(fetchConversationWorkflowBudgets).mockReset();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

function Details(): ReactElement {
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const confirmArchiveRef = useRef<HTMLButtonElement>(null);
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
    onClose: () => {},
  });
}

describe("W5b Conversation Details budget removal", () => {
  it("does not fetch, list, or edit Conversation-wide workflow roots", async () => {
    root = createRoot(container);
    await act(async () => root.render(createElement(Details)));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

    expect(fetchConversationWorkflowBudgets).not.toHaveBeenCalled();
    expect(container.querySelector(".workflow-budget")).toBeNull();
    expect(container.textContent).not.toContain("Workflow budget");
  });
});
