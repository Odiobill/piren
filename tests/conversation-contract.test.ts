import { describe, expect, it } from "vitest";
import {
  scanStewardMentions,
  resolveRecipients,
  resolveStewardMentions,
  applyMembershipChange,
  transitionLifecycle,
  validateTranscriptBudget,
  selectDurableTranscript,
  checkActiveGate,
  canOpenActive,
  isActionPermitted,
  isReadOnlyInspectionAction,
  isActivatingAction,
  dedupePreservingOrder,
  isValidConversationAgentName,
  type ValidatedRecipients,
  type MembershipChange,
  type DurableTranscriptItem,
  type ValidatedTranscriptBudget,
} from "../src/conversation-contract.js";

/**
 * C1 behavior tests for the pure Conversation/mention contract core
 * (ADR-0042, Conversation-Native Workbench Architecture Design §4-§8/§11-§13).
 *
 * Scanner semantics under test are the documented deterministic rules of
 * `scanStewardMentions`:
 *  - `@<lowercase-kebab-agent>` is recognized only at a token boundary
 *    (start of text, or preceded by a character that is not a Unicode letter
 *    or number).
 *  - Mentions inside inline code spans (backtick-delimited), fenced code
 *    blocks (``` or ~~~ lines), and blockquote lines (`>` lines) are never
 *    recognized.
 *  - A doubled `@@` is an escaped literal `@` at any position and never a
 *    mention.
 *  - After a boundary `@`, the scanner consumes the maximal run of
 *    `[A-Za-z0-9_-]`; if the full token does not match the lowercase-kebab
 *    agent pattern, the `@` is ordinary text.
 */

function okRecipients(scan: { mentions: readonly string[] }, runnableAgents: readonly string[]): ValidatedRecipients {
  const resolved = resolveRecipients(scan, runnableAgents);
  if (!resolved.ok) {
    throw new Error(`expected ok resolution, got ${resolved.reason}`);
  }
  return resolved.validated;
}

describe("scanStewardMentions", () => {
  it("recognizes an ordinary mention at the start of text", () => {
    expect(scanStewardMentions("@dipu").mentions).toEqual(["dipu"]);
  });

  it("recognizes a mention after whitespace", () => {
    expect(scanStewardMentions("hello @dipu").mentions).toEqual(["dipu"]);
  });

  it("recognizes mentions after punctuation and keeps textual order", () => {
    expect(scanStewardMentions("(@dipu) and @zai, then @sam").mentions).toEqual(["dipu", "zai", "sam"]);
    expect(scanStewardMentions("!@zai @dipu").mentions).toEqual(["zai", "dipu"]);
  });

  it("does not recognize an @ glued to a word character", () => {
    expect(scanStewardMentions("a@dipu").mentions).toEqual([]);
    expect(scanStewardMentions("foo1@dipu").mentions).toEqual([]);
    expect(scanStewardMentions("é@dipu").mentions).toEqual([]);
  });

  it("does not recognize a second mention glued to a first mention", () => {
    expect(scanStewardMentions("@dipu@zai").mentions).toEqual(["dipu"]);
  });

  it("preserves duplicates at scan level (dedupe happens at resolution)", () => {
    expect(scanStewardMentions("@zai @dipu @zai").mentions).toEqual(["zai", "dipu", "zai"]);
  });

  it("returns no mentions for empty text", () => {
    expect(scanStewardMentions("").mentions).toEqual([]);
    expect(scanStewardMentions("   \n\n").mentions).toEqual([]);
  });

  it("treats invalid agent syntax as ordinary text, never a mention", () => {
    expect(scanStewardMentions("@123abc").mentions).toEqual([]);
    expect(scanStewardMentions("@Dipu").mentions).toEqual([]);
    expect(scanStewardMentions("@dipu_extra").mentions).toEqual([]);
    expect(scanStewardMentions("@").mentions).toEqual([]);
    expect(scanStewardMentions("@!").mentions).toEqual([]);
    expect(scanStewardMentions("@.dipu").mentions).toEqual([]);
  });

  it("terminates a name at punctuation and still recognizes the mention", () => {
    expect(scanStewardMentions("@dipu.").mentions).toEqual(["dipu"]);
    expect(scanStewardMentions("@dipu!").mentions).toEqual(["dipu"]);
  });

  it("never recognizes mentions inside inline code spans", () => {
    expect(scanStewardMentions("run `@dipu` now").mentions).toEqual([]);
    expect(scanStewardMentions("`@dipu` and @zai").mentions).toEqual(["zai"]);
  });

  it("handles double-backtick code spans", () => {
    expect(scanStewardMentions("write ``@dipu`` here").mentions).toEqual([]);
  });

  it("recognizes a mention directly after a closed code span (backtick is a boundary)", () => {
    expect(scanStewardMentions("`code`@zai").mentions).toEqual(["zai"]);
    expect(scanStewardMentions("`code`@@zai").mentions).toEqual([]);
  });

  it("treats 4-space-indented code as text (indented code is not a code region in this grammar)", () => {
    // Documented deterministic semantics: this grammar excludes inline code
    // spans, fenced blocks, and quote lines only; indented code is not a region.
    expect(scanStewardMentions("    @dipu").mentions).toEqual(["dipu"]);
  });

  it("treats an unterminated code span as code to end of text (fail-safe)", () => {
    expect(scanStewardMentions("`@dipu and @zai").mentions).toEqual([]);
  });

  it("never recognizes mentions inside fenced code blocks", () => {
    const fenced = "```\n@dipu\n```\n@zai";
    expect(scanStewardMentions(fenced).mentions).toEqual(["zai"]);
  });

  it("closes a fenced block under CRLF input before recognizing a later mention", () => {
    expect(scanStewardMentions("```\r\n@dipu\r\n```\r\n@zai").mentions).toEqual(["zai"]);
  });

  it("recognizes a fence with an info string and tilde fences", () => {
    expect(scanStewardMentions("```ts\n@dipu\n```\n@zai").mentions).toEqual(["zai"]);
    expect(scanStewardMentions("~~~\n@dipu\n~~~\n@zai").mentions).toEqual(["zai"]);
  });

  it("does not reopen a fence until the closing fence line", () => {
    expect(scanStewardMentions("```\n@dipu\nplain\n@zai\n```\n@sam").mentions).toEqual(["sam"]);
  });

  it("never recognizes mentions inside quoted (blockquote) lines", () => {
    expect(scanStewardMentions("> @dipu").mentions).toEqual([]);
    expect(scanStewardMentions("> quoted @dipu\n@zai").mentions).toEqual(["zai"]);
    expect(scanStewardMentions("> `@dipu`").mentions).toEqual([]);
  });

  it("documents the simplified quote/fence rule: fence markers inside quote lines do not open fences", () => {
    // Deliberate, documented simplification: a `> ``` ` line is quoted text and
    // never opens a fence, so a later non-quote mention is still recognized.
    expect(scanStewardMentions("> ```\n@dipu\n> ```\n@zai").mentions).toEqual(["dipu", "zai"]);
  });

  it("treats @@ as an escaped literal @ and never a mention", () => {
    expect(scanStewardMentions("@@dipu").mentions).toEqual([]);
    expect(scanStewardMentions("a @@dipu").mentions).toEqual([]);
    expect(scanStewardMentions("@@").mentions).toEqual([]);
  });

  it("mixes @@ escapes with real mentions", () => {
    expect(scanStewardMentions("@@ @dipu").mentions).toEqual(["dipu"]);
    expect(scanStewardMentions("@dipu @@zai").mentions).toEqual(["dipu"]);
    expect(scanStewardMentions("@@@dipu").mentions).toEqual(["dipu"]);
  });

  it("never recognizes mentions inside code spans even with @@ present", () => {
    expect(scanStewardMentions("`@@dipu` and @zai").mentions).toEqual(["zai"]);
  });
});

describe("resolveRecipients", () => {
  it("resolves all-runnable mentions to deduped first-mention order", () => {
    const scan = scanStewardMentions("@zai and @dipu then @zai");
    const resolved = resolveRecipients(scan, ["dipu", "zai", "sam"]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.validated.recipients).toEqual(["zai", "dipu"]);
    }
  });

  it("accepts an empty mention list as an empty recipient set", () => {
    const resolved = resolveRecipients(scanStewardMentions("no mentions"), ["dipu"]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.validated.recipients).toEqual([]);
    }
  });

  it("fails atomically when any recognized recipient is unknown", () => {
    const resolved = resolveRecipients(scanStewardMentions("@dipu @nobody"), ["dipu", "zai"]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.unknown).toEqual(["nobody"]);
      expect(resolved.runnableAgents).toEqual(["dipu", "zai"]);
    }
  });

  it("never exposes a partial recipient list on mixed valid+unknown input", () => {
    const resolved = resolveRecipients(scanStewardMentions("@dipu @nobody @zai"), ["dipu", "zai"]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.unknown).toEqual(["nobody"]);
      expect("validated" in resolved).toBe(false);
    }
  });

  it("lists multiple unknowns in first-mention order, deduped", () => {
    const resolved = resolveRecipients(scanStewardMentions("@ghost @zai @ghost @wraith"), ["zai"]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.unknown).toEqual(["ghost", "wraith"]);
    }
  });

  it("treats an agent absent from the injected local runnable set as unknown (excluded-by-absence)", () => {
    // "sam" exists in the vault but is not in this gateway's runnable set.
    const resolved = resolveRecipients(scanStewardMentions("@dipu @sam"), ["dipu"]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.unknown).toEqual(["sam"]);
    }
  });

  it("fails closed when the runnable set is empty and a mention exists", () => {
    const resolved = resolveRecipients(scanStewardMentions("@dipu"), []);
    expect(resolved.ok).toBe(false);
  });

  it("compares runnable-set entries exactly (case-sensitive)", () => {
    const resolved = resolveRecipients(scanStewardMentions("@dipu"), ["Dipu"]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.unknown).toEqual(["dipu"]);
    }
  });

  it("produces a deterministic non-secret failure message", () => {
    const resolved = resolveRecipients(scanStewardMentions("@ghost @zai"), ["dipu", "zai"]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.message).toBe(
        "Unrecognized agent(s): ghost. Local runnable agents: dipu, zai.",
      );
    }
  });

  it("resolveStewardMentions composes scan and resolution", () => {
    const resolved = resolveStewardMentions("please @zai do it", ["dipu", "zai"]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.validated.recipients).toEqual(["zai"]);
    }
  });
});

describe("applyMembershipChange", () => {
  it("adds validated steward recipients to empty membership", () => {
    const validated = okRecipients(scanStewardMentions("@dipu @zai"), ["dipu", "zai", "sam"]);
    const change: MembershipChange = { kind: "steward", recipients: validated };
    expect(applyMembershipChange([], change)).toEqual(["dipu", "zai"]);
  });

  it("adds additively without removing or reordering existing members", () => {
    const validated = okRecipients(scanStewardMentions("@zai @dipu"), ["dipu", "zai", "sam"]);
    const change: MembershipChange = { kind: "steward", recipients: validated };
    expect(applyMembershipChange(["sam", "dipu"], change)).toEqual(["sam", "dipu", "zai"]);
  });

  it("does not duplicate already-present recipients", () => {
    const validated = okRecipients(scanStewardMentions("@dipu"), ["dipu", "zai"]);
    const change: MembershipChange = { kind: "steward", recipients: validated };
    expect(applyMembershipChange(["dipu", "zai"], change)).toEqual(["dipu", "zai"]);
  });

  it("agent-originated addresses preserve membership byte-for-byte and never grow it", () => {
    const members = ["dipu", "zai"];
    const change: MembershipChange = { kind: "agent", to: "sam" };
    const result = applyMembershipChange(members, change);
    expect(result).toBe(members);
    expect(result).toEqual(["dipu", "zai"]);
  });

  it("agent-originated address on empty membership stays empty", () => {
    const members: string[] = [];
    const change: MembershipChange = { kind: "agent", to: "zai" };
    expect(applyMembershipChange(members, change)).toBe(members);
  });

  it("steward recipients are only ever added, never reordered relative to existing", () => {
    const validated = okRecipients(scanStewardMentions("@zai"), ["zai", "sam"]);
    const change: MembershipChange = { kind: "steward", recipients: validated };
    expect(applyMembershipChange(["sam"], change)).toEqual(["sam", "zai"]);
  });
});

describe("transitionLifecycle", () => {
  it("activates a draft to open", () => {
    const result = transitionLifecycle("draft", "activate");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe("open");
    }
  });

  it("archives an open conversation", () => {
    const result = transitionLifecycle("open", "archive");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe("archived");
    }
  });

  it("reopens an archived conversation to open", () => {
    const result = transitionLifecycle("archived", "reopen");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe("open");
    }
  });

  it("rejects archiving a draft (drafts have no persistence implication)", () => {
    const result = transitionLifecycle("draft", "archive");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("archive is not allowed from draft");
    }
  });

  it("rejects activating a non-draft state", () => {
    expect(transitionLifecycle("open", "activate").ok).toBe(false);
    expect(transitionLifecycle("archived", "activate").ok).toBe(false);
  });

  it("rejects reopening a non-archived state", () => {
    expect(transitionLifecycle("draft", "reopen").ok).toBe(false);
    expect(transitionLifecycle("open", "reopen").ok).toBe(false);
  });

  it("rejects archiving an already-archived conversation", () => {
    expect(transitionLifecycle("archived", "archive").ok).toBe(false);
  });

  it("rejects same-state transitions deterministically", () => {
    expect(transitionLifecycle("draft", "activate").ok).toBe(true);
    const alreadyOpen = transitionLifecycle("open", "reopen");
    expect(alreadyOpen.ok).toBe(false);
    if (!alreadyOpen.ok) {
      expect(alreadyOpen.reason).toBe("reopen is not allowed from open");
    }
  });
});

describe("validateTranscriptBudget + selectDurableTranscript", () => {
  const items: readonly DurableTranscriptItem[] = [
    { id: "e1", text: "first" },
    { id: "e2", text: "second" },
    { id: "e3", text: "third" },
    { id: "e4", text: "fourth" },
  ];

  function budget(maxItems: number, maxChars: number): ValidatedTranscriptBudget {
    const result = validateTranscriptBudget({ maxItems, maxChars });
    if (!result.ok) {
      throw new Error(`expected valid budget, got ${result.reason}`);
    }
    return result.budget;
  }

  it("accepts a positive-integer budget", () => {
    expect(validateTranscriptBudget({ maxItems: 8, maxChars: 16384 }).ok).toBe(true);
  });

  it("rejects non-positive, fractional, NaN, and missing budget fields fail-closed", () => {
    expect(validateTranscriptBudget({ maxItems: 0, maxChars: 100 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: -1, maxChars: 100 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: 1.5, maxChars: 100 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: Number.NaN, maxChars: 100 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: 8, maxChars: 0 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: 8, maxChars: -100 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: 8, maxChars: 1.5 }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: 8, maxChars: Number.POSITIVE_INFINITY }).ok).toBe(false);
    // Missing field (runtime undefined) is malformed, never a silent default.
    expect(validateTranscriptBudget({ maxItems: 8, maxChars: undefined as unknown as number }).ok).toBe(false);
    expect(validateTranscriptBudget({ maxItems: undefined as unknown as number, maxChars: 100 }).ok).toBe(false);
  });

  it("rejects a budget with no documented default (both caps always required)", () => {
    expect(validateTranscriptBudget({ maxItems: 0, maxChars: 0 }).ok).toBe(false);
  });

  it("selects the most-recent whole items within maxItems and returns durable order", () => {
    const selection = selectDurableTranscript(items, budget(2, 1000));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected.map((item) => item.id)).toEqual(["e3", "e4"]);
      expect(selection.metadata.selectedCount).toBe(2);
      expect(selection.metadata.omittedCount).toBe(2);
      expect(selection.metadata.truncated).toBe(true);
      expect(selection.metadata.selectedIds).toEqual(["e3", "e4"]);
      expect(selection.metadata.omittedIds).toEqual(["e1", "e2"]);
    }
  });

  it("respects the character cap and reports exact truncation metadata", () => {
    // Texts are first(5) second(6) third(5) fourth(6); maxChars 11 fits exactly
    // the two newest whole items (third+fourth), maxItems 10 never binds.
    const selection = selectDurableTranscript(items, budget(10, 11));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected.map((item) => item.id)).toEqual(["e3", "e4"]);
      expect(selection.metadata.selectedChars).toBe(11);
      expect(selection.metadata.selectedCount).toBe(2);
      expect(selection.metadata.omittedCount).toBe(2);
      expect(selection.metadata.truncated).toBe(true);
    }
  });

  it("binds on whichever cap hits first (chars cap smaller than item count)", () => {
    const selection = selectDurableTranscript(items, budget(10, 6));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected.map((item) => item.id)).toEqual(["e4"]);
      expect(selection.metadata.selectedChars).toBe(6);
      expect(selection.metadata.selectedCount).toBe(1);
      expect(selection.metadata.omittedCount).toBe(3);
    }
  });

  it("fails closed at the selector when the budget is malformed (no default ever applies)", () => {
    const selection = selectDurableTranscript(items, { maxItems: 0, maxChars: 100 });
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.reason).toBe("invalid-budget");
    }
  });

  it("returns no metadata omission when everything fits", () => {
    const selection = selectDurableTranscript(items, budget(10, 1000));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected).toEqual(items);
      expect(selection.metadata.truncated).toBe(false);
      expect(selection.metadata.omittedCount).toBe(0);
      expect(selection.metadata.omittedIds).toEqual([]);
      expect(selection.metadata.selectedChars).toBe(22);
    }
  });

  it("never slices a message body: an oversized newest item selects nothing", () => {
    const big: readonly DurableTranscriptItem[] = [{ id: "big", text: "x".repeat(100) }];
    const selection = selectDurableTranscript(big, budget(8, 50));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected).toEqual([]);
      expect(selection.metadata.truncated).toBe(true);
      expect(selection.metadata.selectedCount).toBe(0);
      expect(selection.metadata.omittedCount).toBe(1);
      expect(selection.metadata.selectedChars).toBe(0);
    }
  });

  it("selects nothing from an empty transcript with truncated=false", () => {
    const selection = selectDurableTranscript([], budget(8, 100));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected).toEqual([]);
      expect(selection.metadata.truncated).toBe(false);
      expect(selection.metadata.omittedCount).toBe(0);
      expect(selection.metadata.selectedChars).toBe(0);
    }
  });

  it("preserves full selected bodies verbatim (no hidden slicing)", () => {
    const selection = selectDurableTranscript(items, budget(1, 1000));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected[0]?.text).toBe("fourth");
      expect(selection.selected[0]?.text.length).toBe(6);
    }
  });

  it("does not skip older items to make room for newer oversized ones (contiguous newest suffix)", () => {
    const mixed: readonly DurableTranscriptItem[] = [
      { id: "old", text: "small" },
      { id: "new", text: "x".repeat(100) },
    ];
    const selection = selectDurableTranscript(mixed, budget(8, 50));
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.selected).toEqual([]);
      expect(selection.metadata.omittedIds).toEqual(["old", "new"]);
    }
  });
});

describe("active switch/attach gate vs read-only inspection", () => {
  it("permits active open when every durable member is in the local runnable set", () => {
    expect(canOpenActive(["dipu", "zai"], ["dipu", "zai", "sam"])).toBe(true);
  });

  it("refuses active open when any durable member is not locally runnable", () => {
    expect(canOpenActive(["dipu", "zai"], ["dipu"])).toBe(false);
  });

  it("reports the missing members deterministically and deduped", () => {
    const gate = checkActiveGate(["dipu", "zai", "zai"], ["dipu"]);
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual(["zai"]);
    expect(gate.malformed).toEqual([]);
  });

  it("fails closed on malformed durable members", () => {
    const gate = checkActiveGate(["dipu", "Bad Member"], ["dipu"]);
    expect(gate.ok).toBe(false);
    expect(gate.malformed).toEqual(["Bad Member"]);
  });

  it("treats empty durable membership as deterministic and openable (draft activation)", () => {
    expect(canOpenActive([], ["dipu"])).toBe(true);
    expect(checkActiveGate([], []).ok).toBe(true);
  });

  it("classifies inspection actions as strictly read-only", () => {
    expect(isReadOnlyInspectionAction("inspect")).toBe(true);
    expect(isReadOnlyInspectionAction("read-history")).toBe(true);
    expect(isReadOnlyInspectionAction("open-as-active")).toBe(false);
    expect(isReadOnlyInspectionAction("switch")).toBe(false);
  });

  it("classifies open/switch/attach as activating actions", () => {
    expect(isActivatingAction("open-as-active")).toBe(true);
    expect(isActivatingAction("attach")).toBe(true);
    expect(isActivatingAction("switch")).toBe(true);
    expect(isActivatingAction("inspect")).toBe(false);
    expect(isActivatingAction("read-history")).toBe(false);
  });

  it("always permits inspection even when members are not runnable (never an authorization bypass)", () => {
    expect(isActionPermitted("inspect", ["dipu", "zai"], ["dipu"])).toBe(true);
    expect(isActionPermitted("read-history", ["dipu", "zai"], ["dipu"])).toBe(true);
    expect(isActionPermitted("read-history", ["dipu", "zai"], [])).toBe(true);
  });

  it("gates activating actions on the all-members-runnable rule", () => {
    expect(isActionPermitted("open-as-active", ["dipu", "zai"], ["dipu", "zai"])).toBe(true);
    expect(isActionPermitted("attach", ["dipu", "zai"], ["dipu", "zai"])).toBe(true);
    expect(isActionPermitted("switch", ["dipu", "zai"], ["dipu"])).toBe(false);
    expect(isActionPermitted("open-as-active", ["dipu", "zai"], ["dipu"])).toBe(false);
  });
});

describe("recipient-order helpers", () => {
  it("dedupes preserving first occurrence order", () => {
    expect(dedupePreservingOrder(["zai", "dipu", "zai", "sam", "dipu"])).toEqual(["zai", "dipu", "sam"]);
    expect(dedupePreservingOrder([])).toEqual([]);
  });

  it("validates the lowercase-kebab agent pattern used by the grammar", () => {
    expect(isValidConversationAgentName("dipu")).toBe(true);
    expect(isValidConversationAgentName("research-agent")).toBe(true);
    expect(isValidConversationAgentName("a1")).toBe(true);
    expect(isValidConversationAgentName("1dipu")).toBe(false);
    expect(isValidConversationAgentName("Dipu")).toBe(false);
    expect(isValidConversationAgentName("dipu_extra")).toBe(false);
    expect(isValidConversationAgentName("")).toBe(false);
    expect(isValidConversationAgentName("dipu extra")).toBe(false);
  });
});
