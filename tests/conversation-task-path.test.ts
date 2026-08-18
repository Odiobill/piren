import { describe, expect, it } from "vitest";
import { extractConversationTaskPath, isConversationInboxTaskPath } from "../src/conversation-task-path.js";

/**
 * T2 — pure C6 task-path helper tests (conversation-task-path.ts). These pin
 * the exact accepted grammar and every deterministic rejection. The helper is
 * a pure inspectable protocol aid: no vault access, no task I/O, no broker
 * wiring. Tests prove syntax only, never agent compliance.
 */

const VALID = "team/dipu/inbox/20260817T144726581Z-implement-the-slice.md";
const VALID_OTHER = "team/kimi/inbox/20260818T073909840Z-review-the-slice.md";

describe("isConversationInboxTaskPath (strict grammar)", () => {
  it("accepts exactly team/<agent>/inbox/<timestamp>-<slug>.md", () => {
    expect(isConversationInboxTaskPath(VALID)).toBe(true);
    expect(isConversationInboxTaskPath(VALID_OTHER)).toBe(true);
  });

  it("rejects claimed coordination filenames", () => {
    expect(isConversationInboxTaskPath("team/dipu/inbox/20260817T144726581Z-implement-the-slice.claimed.ironman.md")).toBe(false);
  });

  it("rejects absolute, relative, traversal, subdirectory, and non-inbox shapes", () => {
    expect(isConversationInboxTaskPath(`/mnt/vault/${VALID}`)).toBe(false);
    expect(isConversationInboxTaskPath(`./${VALID}`)).toBe(false);
    expect(isConversationInboxTaskPath("team/dipu/inbox/../inbox/20260817T144726581Z-x.md")).toBe(false);
    expect(isConversationInboxTaskPath("team/dipu/inbox/sub/20260817T144726581Z-x.md")).toBe(false);
    expect(isConversationInboxTaskPath("team/dipu/outbox/20260817T144726581Z-x.md")).toBe(false);
    expect(isConversationInboxTaskPath("wiki/concepts/20260817T144726581Z-x.md")).toBe(false);
  });

  it("rejects non-timestamp filenames, wrong agent case, missing slug, and non-.md suffixes", () => {
    expect(isConversationInboxTaskPath("team/dipu/inbox/notes.md")).toBe(false);
    expect(isConversationInboxTaskPath("team/dipu/inbox/20260817T144726581Z.md")).toBe(false);
    expect(isConversationInboxTaskPath("team/Dipu/inbox/20260817T144726581Z-x.md")).toBe(false);
    expect(isConversationInboxTaskPath("team/dipu/inbox/20260817T144726581Z-x.txt")).toBe(false);
    expect(isConversationInboxTaskPath("team/dipu/inbox/20260817T144726581Z-x.mdx")).toBe(false);
  });
});

describe("extractConversationTaskPath (pure extraction from handoff text)", () => {
  it("extracts the exact canonical path embedded in prose", () => {
    const result = extractConversationTaskPath(`Please claim ${VALID} and execute it.`);
    expect(result).toEqual({ ok: true, path: VALID });
  });

  it("accepts clean delimiters: string start/end, whitespace, newline, tab, backticks, quotes, parens", () => {
    expect(extractConversationTaskPath(VALID)).toEqual({ ok: true, path: VALID });
    expect(extractConversationTaskPath(`\`${VALID}\``)).toEqual({ ok: true, path: VALID });
    expect(extractConversationTaskPath(`"${VALID}"`)).toEqual({ ok: true, path: VALID });
    expect(extractConversationTaskPath(`(${VALID})`)).toEqual({ ok: true, path: VALID });
    expect(extractConversationTaskPath(`claim\n\t${VALID}\nnow`)).toEqual({ ok: true, path: VALID });
  });

  it("accepts the same path repeated (dedupe is not ambiguity)", () => {
    expect(extractConversationTaskPath(`${VALID} then again ${VALID}`)).toEqual({ ok: true, path: VALID });
  });

  it("rejects two distinct valid paths as ambiguous", () => {
    const result = extractConversationTaskPath(`${VALID} or maybe ${VALID_OTHER}`);
    expect(result).toEqual({ ok: false, reason: "ambiguous-task-paths" });
  });

  it("rejects text with no task path, including arbitrary Markdown/link text", () => {
    expect(extractConversationTaskPath("Please review the diff and report back.")).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath("[docs](https://example.com/docs) and **bold** text")).toEqual({
      ok: false,
      reason: "no-task-path",
    });
  });

  it("rejects absolute paths and URLs containing a valid-looking suffix", () => {
    expect(extractConversationTaskPath(`see /mnt/nas/Piren/${VALID}`)).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath(`see https://vault.example.com/${VALID}`)).toEqual({ ok: false, reason: "no-task-path" });
  });

  it("rejects claimed coordination filenames", () => {
    expect(extractConversationTaskPath("team/dipu/inbox/20260817T144726581Z-x.claimed.ironman.md")).toEqual({
      ok: false,
      reason: "no-task-path",
    });
  });

  it("rejects relative-dot, traversal, subdirectory, and non-inbox shapes", () => {
    expect(extractConversationTaskPath(`./${VALID}`)).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath("team/dipu/inbox/../inbox/20260817T144726581Z-x.md")).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath("team/dipu/inbox/sub/20260817T144726581Z-x.md")).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath("team/dipu/outbox/20260817T144726581Z-x.md")).toEqual({ ok: false, reason: "no-task-path" });
  });

  it("rejects encoded, backslash-escaped, and suffix-extended variants", () => {
    expect(extractConversationTaskPath("team%2Fdipu%2Finbox%2F20260817T144726581Z-x.md")).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath("team\\dipu\\inbox\\20260817T144726581Z-x.md")).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath("team/dipu/inbox/20260817T144726581Z-x.mdx")).toEqual({ ok: false, reason: "no-task-path" });
  });

  it("rejects a path glued to trailing sentence punctuation (conservative: wrap the path in backticks or whitespace)", () => {
    // A trailing '.' could hide a different file (.md.bak); the exact path
    // token must be cleanly delimited.
    expect(extractConversationTaskPath(`claim ${VALID}.`)).toEqual({ ok: false, reason: "no-task-path" });
    expect(extractConversationTaskPath(`claim \`${VALID}\`.`)).toEqual({ ok: true, path: VALID });
  });
});
