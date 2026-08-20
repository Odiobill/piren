import { describe, expect, it } from "vitest";
import {
  COMPOSER_INTERLOCK_CLEARED_ANNOUNCEMENT,
  composeInterlockReason,
  composerInterlockVisibleText,
  isComposerInterlocked,
  reduceComposerInterlock,
  type ComposerInterlockState,
} from "../web/src/composer-interlock.js";

/**
 * U2 — selected-Conversation composer interlock state machine (0.2.0
 * amendment §6.2). Pure reducer for the exact 8 transitions:
 * editable · interlocked-draft · interlocked-ack, with byte-for-byte draft
 * preservation/restoration and a non-resendable acknowledgement. The reason
 * derivation reflects broker state only (active run / pending approval).
 */

function editable(): ComposerInterlockState {
  return { state: "editable" };
}

describe("reduceComposerInterlock (transitions 1-8)", () => {
  it("transition 1: interlock begins from editable with an unsent draft preserves it byte-for-byte", () => {
    const draft = "please @dipu review this\u0000draft \ud83d\ude80";
    const next = reduceComposerInterlock(editable(), { type: "interlock-begin", draft });
    expect(next).toEqual({ state: "interlocked-draft", draft });
    // The preserved draft is visible (not the editable text) and byte-identical.
    expect(composerInterlockVisibleText(next, "different live text")).toBe(draft);
  });

  it("transition 2: interlock begins from editable and empty is interlocked-draft with an empty draft", () => {
    const next = reduceComposerInterlock(editable(), { type: "interlock-begin", draft: "" });
    expect(next).toEqual({ state: "interlocked-draft", draft: "" });
    expect(composerInterlockVisibleText(next, "anything")).toBe("");
  });

  it("transition 3: an accepted send that immediately enters interlock becomes a non-resendable acknowledgement", () => {
    const next = reduceComposerInterlock(editable(), { type: "send-accepted", text: "do this task", interlockFollows: true });
    expect(next).toEqual({ state: "interlocked-ack", ack: "do this task" });
    expect(composerInterlockVisibleText(next, "")).toBe("do this task");
    // The ack is never a draft: clearing it yields an empty composer.
    const cleared = reduceComposerInterlock(next, { type: "interlock-clear" });
    expect(cleared).toEqual({ state: "editable" });
  });

  it("transition 4: an accepted send with no following interlock stays editable (clear-on-success)", () => {
    expect(reduceComposerInterlock(editable(), { type: "send-accepted", text: "hi", interlockFollows: false })).toEqual({ state: "editable" });
  });

  it("transition 5: a failed/rejected send stays editable (no acknowledgement state)", () => {
    expect(reduceComposerInterlock(editable(), { type: "send-rejected" })).toEqual({ state: "editable" });
    // Even from a prior interlocked state, a rejected send collapses to editable
    // (a rejected send can only be initiated while editable in the component).
    expect(reduceComposerInterlock({ state: "interlocked-ack", ack: "x" }, { type: "send-rejected" })).toEqual({ state: "editable" });
  });

  it("transition 6: interlock clears from interlocked-draft and the draft is restored byte-for-byte to editable", () => {
    const draft = "unsent draft \u2026";
    const interlocked = reduceComposerInterlock(editable(), { type: "interlock-begin", draft });
    const cleared = reduceComposerInterlock(interlocked, { type: "interlock-clear" });
    expect(cleared).toEqual({ state: "editable" });
    // The component must restore `draft` into the editable text on this clear.
    expect(composerInterlockVisibleText(interlocked, "")).toBe(draft);
  });

  it("transition 7: interlock clears from interlocked-ack and the acknowledgement is cleared (empty, not restored)", () => {
    const ack = reduceComposerInterlock(editable(), { type: "send-accepted", text: "sent message", interlockFollows: true });
    const cleared = reduceComposerInterlock(ack, { type: "interlock-clear" });
    expect(cleared).toEqual({ state: "editable" });
    // The ack is NOT restored as a draft: the component sets empty text.
  });

  it("transition 8: selection change discards interlock/ack state (back to editable)", () => {
    expect(reduceComposerInterlock({ state: "interlocked-draft", draft: "x" }, { type: "selection-change" })).toEqual({ state: "editable" });
    expect(reduceComposerInterlock({ state: "interlocked-ack", ack: "x" }, { type: "selection-change" })).toEqual({ state: "editable" });
    expect(reduceComposerInterlock(editable(), { type: "selection-change" })).toEqual({ state: "editable" });
  });

  it("interlock-begin is idempotent when already interlocked (no draft clobber)", () => {
    const interlocked = reduceComposerInterlock(editable(), { type: "interlock-begin", draft: "original" });
    const again = reduceComposerInterlock(interlocked, { type: "interlock-begin", draft: "stale" });
    expect(again).toEqual({ state: "interlocked-draft", draft: "original" });
  });
});

describe("composer interlock projections", () => {
  it("isComposerInterlocked is true exactly when not editable", () => {
    expect(isComposerInterlocked(editable())).toBe(false);
    expect(isComposerInterlocked({ state: "interlocked-draft", draft: "" })).toBe(true);
    expect(isComposerInterlocked({ state: "interlocked-ack", ack: "" })).toBe(true);
  });

  it("composerInterlockVisibleText returns the editable text only while editable", () => {
    expect(composerInterlockVisibleText(editable(), "live draft")).toBe("live draft");
  });
});

describe("composeInterlockReason (broker state reflection)", () => {
  it("prioritizes a pending approval as the specific actionable reason", () => {
    expect(
      composeInterlockReason({
        activeRuns: [{ agent: "dipu", phase: "working" }],
        approvals: [{ agent: "dipu" }],
      }),
    ).toBe("Approval required for dipu");
  });

  it("falls back to the active run working/typing reason when no approval is pending", () => {
    expect(composeInterlockReason({ activeRuns: [{ agent: "dipu", phase: "working" }], approvals: [] })).toBe("dipu is working…");
    expect(composeInterlockReason({ activeRuns: [{ agent: "zai", phase: "typing" }], approvals: [] })).toBe("zai is typing…");
  });

  it("returns null when there is neither an active run nor a pending approval", () => {
    expect(composeInterlockReason({ activeRuns: [], approvals: [] })).toBeNull();
  });

  it("uses the first (most recent) entry deterministically", () => {
    expect(
      composeInterlockReason({
        activeRuns: [
          { agent: "dipu", phase: "working" },
          { agent: "zai", phase: "typing" },
        ],
        approvals: [],
      }),
    ).toBe("dipu is working…");
    expect(
      composeInterlockReason({ activeRuns: [], approvals: [{ agent: "zai" }, { agent: "dipu" }] }),
    ).toBe("Approval required for zai");
  });
});

describe("interlock clear announcement", () => {
  it("is a single neutral availability line (never a completion/failure claim)", () => {
    expect(COMPOSER_INTERLOCK_CLEARED_ANNOUNCEMENT).toBe("Composer available.");
  });
});
