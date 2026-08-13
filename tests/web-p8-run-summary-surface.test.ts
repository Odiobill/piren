// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationRunSummaries } from "../web/src/conversation-summary-disclosure.js";
import type { ConversationRunSummary } from "../web/src/conversation-summary.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §4) — the
 * collapsed disclosure surface for the bounded in-memory run summaries plus
 * static lifecycle/boundary proofs (capture only in the live durable-terminal
 * path; cleared on selection change/reread/reconnect/stream end; never
 * reconstructed from history; zero storage/API additions).
 */

const SUMMARIES: ConversationRunSummary[] = [
  { agent: "dipu", partial: "Hello from dipu.", truncated: false, terminal: { runStatus: "completed" } },
  { agent: "zai", partial: "", truncated: false, terminal: { runStatus: "failed", failureKind: "provider_error" } },
];

describe("ConversationRunSummaries disclosure (jsdom)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(summaries: ConversationRunSummary[]): void {
    root = createRoot(container);
    act(() => {
      root.render(createElement(ConversationRunSummaries, { summaries }));
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

  it("is collapsed by default with truthful disclosure semantics (aria-expanded/aria-controls)", () => {
    render(SUMMARIES);
    const buttons = container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
    expect(buttons.length).toBe(2);
    for (const button of Array.from(buttons)) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).not.toBeNull();
      expect(button.getAttribute("aria-label")).toContain("Run summary");
    }
    // Collapsed: no partial text or terminal label visible yet.
    expect(container.textContent).not.toContain("Hello from dipu.");
    expect(container.textContent).not.toContain("provider error");
  });

  it("expanding one summary reveals agent, truthful terminal label, already-permitted text, and the transient note", async () => {
    render(SUMMARIES);
    const buttons = container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
    await act(async () => {
      buttons[0]!.click();
    });
    const expanded = container.querySelector<HTMLButtonElement>("button[aria-expanded='true']");
    expect(expanded).not.toBeNull();
    const panel = expanded!.getAttribute("aria-controls");
    const panelEl = panel === null ? null : container.querySelector<HTMLElement>(`#${panel}`);
    expect(panelEl).not.toBeNull();
    expect(panelEl!.textContent).toContain("dipu");
    expect(panelEl!.textContent).toContain("Hello from dipu.");
    // Truthful terminal label (completed) — never raw provider internals.
    expect(panelEl!.textContent).toMatch(/completed/i);
    expect(panelEl!.textContent).toContain("Transient");
    // The other summary stays collapsed.
    const collapsedCount = container.querySelectorAll("button[aria-expanded='false']").length;
    expect(collapsedCount).toBe(1);
  });

  it("an empty-partial summary expands without fabricating text", async () => {
    render(SUMMARIES);
    const buttons = container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
    await act(async () => {
      buttons[1]!.click();
    });
    const panel = container.querySelector<HTMLElement>("[id^='run-summary-']");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("zai");
    expect(panel!.textContent).not.toContain("403");
    expect(panel!.textContent).not.toContain("RegionError");
    expect(panel!.textContent).not.toContain("opencode");
  });

  it("renders nothing for an empty summary set", () => {
    render([]);
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });
});

const webSrc = join(process.cwd(), "web", "src");

describe("P8 run summary lifecycle/boundaries (static)", () => {
  it("captures summaries ONLY in the live durable-terminal frame path (never from history)", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The capture helper is called next to the durable terminal reconciliation
    // (run_finished/run_cancelled with runAgent), never in the history path.
    const captureIndex = timeline.indexOf("captureConversationRunSummary(");
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    const beforeHistory = timeline.slice(0, timeline.indexOf("replaceConversationHistoric("));
    // No capture before/inside the whole-history reread path.
    expect(beforeHistory.includes("captureConversationRunSummary(")).toBe(false);
  });

  it("clears summaries in every transient-lifecycle path (selection change, reread, reconnect, stream end)", async () => {
    const timeline = await readFile(join(webSrc, "ConversationTimeline.tsx"), "utf8");
    // The summary state is reset wherever the transient U4 activity is
    // cleared by the runtime paths (reread, stream end, error) — compare the
    // set-call forms, not the useState initializer.
    const activityClears = timeline.split("setActivity(emptyConversationActivity())").length - 1;
    const summaryClears = timeline.split("setRunSummaries([])").length - 1;
    expect(activityClears).toBeGreaterThanOrEqual(3);
    expect(summaryClears).toBeGreaterThanOrEqual(activityClears);
  });

  it("the summary core and disclosure add no storage, routes, SSE, polling, or API imports", async () => {
    const summaryCore = await readFile(join(webSrc, "conversation-summary.ts"), "utf8");
    const disclosure = await readFile(join(webSrc, "conversation-summary-disclosure.tsx"), "utf8");
    for (const source of [summaryCore, disclosure]) {
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("sessionStorage");
      expect(source).not.toContain("indexedDB");
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain("WebSocket");
      expect(source).not.toContain("setInterval");
      expect(source).not.toContain("poll");
    }
  });

  it("the disclosure never surfaces private reasoning or raw provider internals", async () => {
    const disclosure = await readFile(join(webSrc, "conversation-summary-disclosure.tsx"), "utf8");
    expect(disclosure).not.toContain("thinking");
    expect(disclosure).not.toContain("errorMessage");
    expect(disclosure).not.toContain("RegionError");
    expect(disclosure).not.toContain("stopReason");
  });
});
