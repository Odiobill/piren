import { describe, expect, it } from "vitest";
import {
  applyMentionCompletion,
  filterRunnableCompletions,
  findMentionTrigger,
  nextCompletionIndex,
} from "../web/src/conversation-autocomplete.js";
import type { RoomAgentEntry } from "../web/src/rooms.js";

/**
 * U3 — server-authoritative mention autocomplete pure core (accepted 0.2.0
 * UX plan §U3). The `@` convenience list is sourced ONLY from the locally
 * runnable roster; the browser never scans/resolves mentions for dispatch,
 * membership, or routing — insertion edits text only and the gateway remains
 * the sole mention parser and recipient authority.
 */

const ROSTER: RoomAgentEntry[] = [
  { name: "dipu", online: true },
  { name: "kimi", online: true },
  { name: "sam", online: false },
  { name: "zora", online: true },
];

describe("findMentionTrigger (caret-local @ token detection)", () => {
  it("finds the @ immediately before the caret", () => {
    expect(findMentionTrigger("@", 1)).toEqual({ ok: true, trigger: { start: 0, token: "" } });
    expect(findMentionTrigger("hi @fa", 6)).toEqual({ ok: true, trigger: { start: 3, token: "fa" } });
    expect(findMentionTrigger("@fak", 4)).toEqual({ ok: true, trigger: { start: 0, token: "fak" } });
    expect(findMentionTrigger("a@b", 3)).toEqual({ ok: true, trigger: { start: 1, token: "b" } });
  });

  it("never triggers after whitespace, at the start, or without an @", () => {
    expect(findMentionTrigger("hi @fa ", 7)).toEqual({ ok: false });
    expect(findMentionTrigger("plain text", 5)).toEqual({ ok: false });
    expect(findMentionTrigger("", 0)).toEqual({ ok: false });
    expect(findMentionTrigger("no mention", 0)).toEqual({ ok: false });
  });
});

describe("filterRunnableCompletions (runnable-only convenience list)", () => {
  it("offers only locally runnable agents, prefix-matched case-insensitively, sorted", () => {
    expect(filterRunnableCompletions(ROSTER, "")).toEqual(["dipu", "kimi", "zora"]);
    expect(filterRunnableCompletions(ROSTER, "d")).toEqual(["dipu"]);
    expect(filterRunnableCompletions(ROSTER, "K")).toEqual(["kimi"]);
    expect(filterRunnableCompletions(ROSTER, "sa")).toEqual([]); // sam is offline
    expect(filterRunnableCompletions(ROSTER, "z")).toEqual(["zora"]);
    expect(filterRunnableCompletions([], "x")).toEqual([]);
  });
});

describe("applyMentionCompletion (text-only insertion)", () => {
  it("replaces the @token span with '@name ' and moves the caret after it", () => {
    expect(applyMentionCompletion("hi @fa", 6, 3, "fake")).toEqual({ text: "hi @fake ", caret: 9 });
    expect(applyMentionCompletion("@f", 2, 0, "dipu")).toEqual({ text: "@dipu ", caret: 6 });
    expect(applyMentionCompletion("a@b then", 3, 1, "kimi")).toEqual({ text: "a@kimi  then", caret: 7 });
  });
});

describe("nextCompletionIndex (wrapped keyboard navigation)", () => {
  it("wraps around the visible list", () => {
    expect(nextCompletionIndex(0, 3, 1)).toBe(1);
    expect(nextCompletionIndex(2, 3, 1)).toBe(0);
    expect(nextCompletionIndex(0, 3, -1)).toBe(2);
    expect(nextCompletionIndex(-1, 3, 1)).toBe(0);
    expect(nextCompletionIndex(-1, 3, -1)).toBe(2);
  });

  it("is safe for an empty list", () => {
    expect(nextCompletionIndex(0, 0, 1)).toBe(-1);
    expect(nextCompletionIndex(-1, 0, -1)).toBe(-1);
  });
});
