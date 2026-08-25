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
 * U2 + VR-1 — selected-Conversation composer interlock state machine.
 * Pure reducer: editable · interlocked-draft, with byte-for-byte unsent-draft
 * preservation/restoration. VR-1 removed the sent-message acknowledgement
 * state entirely: a submitted message clears from the composer immediately
 * and its durable timeline event is the only evidence — no accepted send is
 * ever retained or re-shown. A send that fails while a REAL interlock is
 * active preserves its exact draft inside that read-only interlock (never an
 * editable bypass) until the interlock clears.
 */

function editable(): ComposerInterlockState {
  return { state: "editable" };
}

describe("reduceComposerInterlock", () => {
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

  it("VR-1: no acknowledgement state exists — an accepted send never enters the reducer as retained text", () => {
    // The reducer's state space is closed: editable or interlocked-draft.
    const states: Array<ComposerInterlockState["state"]> = ["editable", "interlocked-draft"];
    for (const state of states) {
      const current: ComposerInterlockState = state === "editable" ? { state: "editable" } : { state: "interlocked-draft", draft: "d" };
      // Clearing any state yields plain editable with NO retained text.
      expect(reduceComposerInterlock(current, { type: "interlock-clear" })).toEqual({ state: "editable" });
    }
  });

  it("VR-1: a send that fails while a REAL interlock is active preserves the exact failed draft read-only until clear", () => {
    const draft = "failed while running \u2026";
    const interlocked = reduceComposerInterlock(editable(), { type: "interlock-begin", draft: "" });
    const preserved = reduceComposerInterlock(interlocked, { type: "send-failed-interlocked", draft });
    expect(preserved).toEqual({ state: "interlocked-draft", draft });
    // Still read-only protected (not editable), and the exact bytes survive.
    expect(isComposerInterlocked(preserved)).toBe(true);
    expect(composerInterlockVisibleText(preserved, "")).toBe(draft);
    // It becomes editable only when the real interlock clears.
    expect(reduceComposerInterlock(preserved, { type: "interlock-clear" })).toEqual({ state: "editable" });
  });

  it("transition 5: a failed/rejected send with no interlock collapses to editable", () => {
    expect(reduceComposerInterlock(editable(), { type: "send-rejected" })).toEqual({ state: "editable" });
    expect(reduceComposerInterlock({ state: "interlocked-draft", draft: "x" }, { type: "send-rejected" })).toEqual({ state: "editable" });
  });

  it("transition 6: interlock clears from interlocked-draft and the draft is restored byte-for-byte to editable", () => {
    const draft = "unsent draft \u2026";
    const interlocked = reduceComposerInterlock(editable(), { type: "interlock-begin", draft });
    const cleared = reduceComposerInterlock(interlocked, { type: "interlock-clear" });
    expect(cleared).toEqual({ state: "editable" });
    // The component must restore `draft` into the editable text on this clear.
    expect(composerInterlockVisibleText(interlocked, "")).toBe(draft);
  });

  it("selection change discards interlock state (back to editable)", () => {
    expect(reduceComposerInterlock({ state: "interlocked-draft", draft: "x" }, { type: "selection-change" })).toEqual({ state: "editable" });
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
