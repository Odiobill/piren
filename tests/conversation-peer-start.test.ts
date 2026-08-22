import { describe, expect, it } from "vitest";
import {
  peerConversationTitle,
  peerStartOriginBody,
  parsePeerAudienceStartRequest,
} from "../src/conversation-peer-start.js";

/**
 * P3.1 (workbench-ux-follow-up-design §1.3; accepted P2 contract) — pure
 * peer-audience contract core: strict `{peers}` parsing, 2–8 cardinality,
 * blank/name-grammar/duplicate rejection (never collapsed), deterministic
 * creation-time canonical sort, immutable cardinal title, truthful origin
 * body. Browser/gateway/filesystem-free; no config reads.
 */

describe("parsePeerAudienceStartRequest", () => {
  it("accepts a valid distinct set and returns it canonically sorted", () => {
    const result = parsePeerAudienceStartRequest({ peers: ["kimi", "dipu"] });
    expect(result).toEqual({ ok: true, audience: ["dipu", "kimi"] });
    const eight = ["h", "g", "f", "e", "d", "c", "b", "a"];
    const result8 = parsePeerAudienceStartRequest({ peers: eight });
    expect(result8).toEqual({ ok: true, audience: ["a", "b", "c", "d", "e", "f", "g", "h"] });
  });

  it("rejects malformed envelopes: non-object, missing/extra keys, non-array peers", () => {
    expect(parsePeerAudienceStartRequest(null).ok).toBe(false);
    expect(parsePeerAudienceStartRequest("x").ok).toBe(false);
    expect(parsePeerAudienceStartRequest([]).ok).toBe(false);
    expect(parsePeerAudienceStartRequest({}).ok).toBe(false);
    expect(parsePeerAudienceStartRequest({ agent: "dipu" }).ok).toBe(false);
    expect(parsePeerAudienceStartRequest({ peers: ["a"], extra: 1 }).ok).toBe(false);
    expect(parsePeerAudienceStartRequest({ peers: "dipu" }).ok).toBe(false);
  });

  it("rejects blank and grammar-invalid member names without collapsing them", () => {
    const result = parsePeerAudienceStartRequest({ peers: ["dipu", "   ", "Bad_Name"] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.kind === "invalid-members") {
      expect(result.failure.members).toContainEqual({ peer: "   ", reason: "blank", index: 1 });
      expect(result.failure.members).toContainEqual({ peer: "Bad_Name", reason: "invalid-name", index: 2 });
      // Non-failing members are never listed.
      expect(result.failure.members.some((m) => "peer" in m && m.peer === "dipu")).toBe(false);
    } else {
      throw new Error("expected invalid-members failure");
    }
  });

  it("rejects duplicate members and never collapses them", () => {
    const result = parsePeerAudienceStartRequest({ peers: ["dipu", "kimi", "dipu"] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.kind === "invalid-members") {
      expect(result.failure.members).toContainEqual({ peer: "dipu", reason: "duplicate", index: 2 });
    } else {
      throw new Error("expected invalid-members failure");
    }
  });

  it("enforces cardinality 2–8 on the raw entry list before member checks", () => {
    const one = parsePeerAudienceStartRequest({ peers: ["dipu"] });
    expect(one).toEqual({
      ok: false,
      failure: { kind: "cardinality", count: 1 },
    });
    const nine = parsePeerAudienceStartRequest({ peers: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] });
    expect(nine).toEqual({
      ok: false,
      failure: { kind: "cardinality", count: 9 },
    });
    // Cardinality precedes member validation deterministically.
    const oneInvalid = parsePeerAudienceStartRequest({ peers: ["NOT_VALID"] });
    expect(oneInvalid).toEqual({ ok: false, failure: { kind: "cardinality", count: 1 } });
  });
});

describe("peerConversationTitle", () => {
  it("renders the immutable cardinal title for valid counts", () => {
    expect(peerConversationTitle(2)).toBe("Conversation with 2 agents");
    expect(peerConversationTitle(3)).toBe("Conversation with 3 agents");
    expect(peerConversationTitle(8)).toBe("Conversation with 8 agents");
  });

  it("refuses counts outside the created range", () => {
    expect(() => peerConversationTitle(1)).toThrow();
    expect(() => peerConversationTitle(9)).toThrow();
  });
});

describe("peerStartOriginBody", () => {
  it("renders the truthful system-origin body over canonically ordered members", () => {
    expect(peerStartOriginBody(["dipu", "kimi"])).toBe(
      "The steward requested starting this peer conversation with: dipu, kimi.",
    );
  });
});

describe("validatePeerRunnability", () => {
  it("accepts when every member is in the injected runnable set", async () => {
    const { validatePeerRunnability } = await import("../src/conversation-peer-start.js");
    expect(validatePeerRunnability(["dipu", "kimi"], ["dipu", "kimi", "zai"])).toEqual({ ok: true });
  });

  it("fails with all non-runnable members listed (whole-set semantics)", async () => {
    const { validatePeerRunnability } = await import("../src/conversation-peer-start.js");
    const result = validatePeerRunnability(["dipu", "zora"], ["dipu"]);
    expect(result).toEqual({ ok: false, notRunnable: [{ peer: "zora", index: 1 }] });
  });
});

describe("peerStartOriginBody canonicalization (P3.1 correction)", () => {
  it("renders canonical ascending names even when the caller passes an unsorted valid set, never mutating caller input", () => {
    const input = ["kimi", "dipu"];
    expect(peerStartOriginBody(input)).toBe(
      "The steward requested starting this peer conversation with: dipu, kimi.",
    );
    // The caller's array is never reordered.
    expect(input).toEqual(["kimi", "dipu"]);
  });
});

describe("parsePeerAudienceStartRequest totality on unknown input (P3.1 correction)", () => {
  it("never coerces non-string entries: a throwing toString object fails safely and deterministically", () => {
    const hostile = {
      toString() {
        throw new Error("hostile coercion must never run");
      },
    };
    const result = parsePeerAudienceStartRequest({ peers: [hostile, "dipu"] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.kind === "invalid-members") {
      expect(result.failure.members).toContainEqual({ reason: "non-string", index: 0 });
      // Arbitrary object data is never echoed into the failure.
      expect(JSON.stringify(result.failure)).not.toContain("hostile");
    } else {
      throw new Error("expected invalid-members failure");
    }
  });
});
