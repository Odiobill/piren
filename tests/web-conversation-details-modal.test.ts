// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationDetailsModal } from "../web/src/ConversationDetailsModal.js";
import type { RenameError } from "../web/src/conversation-details.js";
import type { ConversationRecord } from "../web/src/conversations.js";

/**
 * U2 correction regression (Sam final-acceptance correction to `97b3759`):
 * while a rename Save is in flight, Escape must never dismiss the details
 * modal — if the request then fails, the required bounded failure and
 * explicit Retry must stay visible on the mounted modal. After the request
 * settles, normal Escape dismissal returns (the navigator's focus return to
 * the invoking button is covered by the existing closeDetails pin).
 */

const CONVERSATION: ConversationRecord = {
  id: "20260811T000000000Z-correction",
  title: "Current title",
  path: "collaboration/conversations/20260811T000000000Z-correction/index.md",
  createdBy: "steward",
  audience: [],
  status: "open",
  created: "2026-08-11T00:00:00.000Z",
  updated: "2026-08-11T00:00:00.000Z",
};

const BUSY_ERROR: RenameError = {
  kind: "conflict",
  message: "The conversation is busy; retry after it completes.",
};

function Harness({ onRename }: { onRename: (title: string) => Promise<RenameError | null> }): ReactElement {
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
    onRename,
    onClose,
  });
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

function changeTitle(container: HTMLElement, value: string): void {
  const input = container.querySelector<HTMLInputElement>("#conversation-title-input");
  expect(input).not.toBeNull();
  // React 19 controlled inputs: write through the native value setter, then
  // dispatch the input event so the onChange handler sees the new value.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConversationDetailsModal Escape while rename Save is in flight (U2 correction)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(onRename: (title: string) => Promise<RenameError | null>): void {
    root = createRoot(container);
    act(() => {
      root.render(createElement(Harness, { onRename }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("Escape never dismisses while a rename is in flight; the bounded failure + Retry stay visible after it fails", async () => {
    let resolveRename!: (error: RenameError | null) => void;
    const pending = new Promise<RenameError | null>((resolve) => {
      resolveRename = resolve;
    });
    const onRename = vi.fn(() => pending);
    render(onRename);

    expect(container.querySelector("#conversation-details-dialog")).not.toBeNull();

    // Enter a differing title and start the Save.
    act(() => changeTitle(container, "New title"));
    const save = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(save).not.toBeNull();
    expect(save!.disabled).toBe(false);
    act(() => {
      save!.click();
    });
    // In flight: Save is disabled and onRename has been invoked once.
    expect(save!.disabled).toBe(true);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("New title");

    // Escape while the request is pending must NOT dismiss the modal.
    act(() => pressEscape());
    expect(container.querySelector("#conversation-details-dialog")).not.toBeNull();

    // The request fails with a bounded error: the role=alert failure and the
    // explicit Retry affordance must be VISIBLE on the still-mounted modal.
    await act(async () => {
      resolveRename(BUSY_ERROR);
      await pending;
    });
    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("busy");
    // W5b: Conversation Details has no workflow-budget retry; this is the
    // sole retry affordance in the modal.
    const retryButtons = Array.from(
      container.querySelectorAll<HTMLElement>(".details-rename-error button"),
    ).filter((button) => button.textContent === "Retry");
    expect(retryButtons).toHaveLength(1);
    expect(container.querySelector("#conversation-details-dialog")).not.toBeNull();

    // After the request settles, Escape dismisses normally again.
    act(() => pressEscape());
    expect(container.querySelector("#conversation-details-dialog")).toBeNull();
  });

  it("idle Escape (no rename started) still dismisses the modal immediately", () => {
    const onRename = vi.fn(async () => null);
    render(onRename);
    expect(container.querySelector("#conversation-details-dialog")).not.toBeNull();
    act(() => pressEscape());
    expect(container.querySelector("#conversation-details-dialog")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});
