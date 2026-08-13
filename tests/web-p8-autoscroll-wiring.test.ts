// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  EMPTY_CONVERSATION_SCROLL_WIRING,
  applyConversationScrollWiring,
  type ConversationScrollWiringState,
} from "../web/src/conversation-scroll-wiring.js";

/**
 * P8 (accepted `conversation-p8-pilot-correction-contract.md` §5) — commit-time
 * append autoscroll wiring. The anchor decision runs at React commit time
 * (layout effect) driven by a content-version bump, using PRE-commit metrics:
 * an anchored reader follows durable/activity/summary appends to the new
 * bottom (auto behavior — P8 amends P6's smooth default); an upward reader's
 * exact position is preserved; batch appends produce ONE correct decision.
 * This module does not exist yet: RED.
 */

function el(overrides: { scrollTop?: number; clientHeight?: number; scrollHeight?: number }): {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => void;
  scrollToCalls: Array<{ top: number; behavior: ScrollBehavior }>;
} {
  // jsdom does no layout; the test controls the real measured values.
  const calls: Array<{ top: number; behavior: ScrollBehavior }> = [];
  const element = {
    scrollTop: overrides.scrollTop ?? 0,
    clientHeight: overrides.clientHeight ?? 300,
    scrollHeight: overrides.scrollHeight ?? 3000,
    scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => {
      calls.push({ top: options.top, behavior: options.behavior ?? "auto" });
      element.scrollTop = options.top;
    },
  };
  const tracked = element as typeof element & { scrollToCalls: Array<{ top: number; behavior: ScrollBehavior }> };
  tracked.scrollToCalls = calls;
  return tracked;
}

function state(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, initialAnchor = false): ConversationScrollWiringState {
  return { metrics: { ...metrics }, initialAnchor };
}

describe("applyConversationScrollWiring (P8 §5 commit-time wiring)", () => {
  it("an initial history load forces the bottom (initialAnchor)", () => {
    const element = el({ scrollTop: 0, clientHeight: 300, scrollHeight: 3000 });
    const next = applyConversationScrollWiring(element, state({ scrollTop: 0, clientHeight: 300, scrollHeight: 3000 }, true));
    expect(element.scrollToCalls).toHaveLength(1);
    expect(element.scrollToCalls[0]?.top).toBe(3000);
    expect(element.scrollToCalls[0]?.behavior).toBe("auto");
    expect(next.initialAnchor).toBe(false);
    // The returned metrics are the PRE-decision commit values; only
    // scrollHeight is carried to the next commit's pre-append decision.
    expect(next.metrics).toMatchObject({ scrollTop: 0, scrollHeight: 3000 });
  });

  it("an anchored reader follows an append to the new bottom using the PRE-commit scrollHeight", () => {
    const element = el({ scrollTop: 2700, clientHeight: 300, scrollHeight: 3600 });
    const next = applyConversationScrollWiring(
      element,
      state({ scrollTop: 2700, clientHeight: 300, scrollHeight: 3000 }),
    );
    expect(element.scrollToCalls).toHaveLength(1);
    expect(element.scrollToCalls[0]?.top).toBe(3600);
    // Pre-decision scrollTop is captured; scrollHeight carries forward.
    expect(next.metrics).toMatchObject({ scrollTop: 2700, scrollHeight: 3600 });
  });

  it("an upward reader keeps the exact scroll position (no forced jump)", () => {
    const element = el({ scrollTop: 1000, clientHeight: 300, scrollHeight: 3600 });
    const next = applyConversationScrollWiring(
      element,
      state({ scrollTop: 1000, clientHeight: 300, scrollHeight: 3000 }),
    );
    expect(element.scrollToCalls).toHaveLength(0);
    expect(element.scrollTop).toBe(1000);
    expect(next.metrics).toMatchObject({ scrollTop: 1000, scrollHeight: 3600 });
  });

  it("batch appends in one commit produce exactly ONE correct decision", () => {
    // Two chunks appended before the single commit-time effect run: the
    // pre-commit scrollHeight is 3000 and the post-commit height is 4200.
    const element = el({ scrollTop: 2700, clientHeight: 300, scrollHeight: 4200 });
    const next = applyConversationScrollWiring(
      element,
      state({ scrollTop: 2700, clientHeight: 300, scrollHeight: 3000 }),
    );
    expect(element.scrollToCalls).toHaveLength(1);
    expect(element.scrollToCalls[0]?.top).toBe(4200);
    expect(next.metrics).toMatchObject({ scrollHeight: 4200 });
  });

  it("a near-bottom reader within the threshold is still anchored and follows", () => {
    const element = el({ scrollTop: 4200 - 300 - 20, clientHeight: 300, scrollHeight: 4800 });
    const next = applyConversationScrollWiring(
      element,
      state({ scrollTop: 4200 - 300 - 20, clientHeight: 300, scrollHeight: 4200 }),
    );
    expect(element.scrollToCalls).toHaveLength(1);
    expect(element.scrollToCalls[0]?.top).toBe(4800);
    expect(next.metrics).toMatchObject({ scrollTop: 4200 - 300 - 20, scrollHeight: 4800 });
  });

  it("no metrics yet (first commit) is a no-op", () => {
    const element = el({ scrollTop: 0, clientHeight: 300, scrollHeight: 3000 });
    const next = applyConversationScrollWiring(element, EMPTY_CONVERSATION_SCROLL_WIRING);
    expect(element.scrollToCalls).toHaveLength(0);
    expect(next.metrics).toMatchObject({ scrollTop: 0, scrollHeight: 3000 });
  });
});
