import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerStartAmbiguousError, UnauthorizedError, startPeerConversation } from "../web/src/api.js";

/**
 * P3.3 — actual API-client evidence for startPeerConversation over the
 * existing authenticated peer start route: POST with the Bearer auth header,
 * exact `{peers}` JSON, 201 safe-response parsing, bounded definitive-error
 * handling, and network-level ambiguity classified truthfully (never an
 * automatic retry).
 */

const CONVERSATION = {
  id: "c9",
  title: "Conversation with 2 agents",
  audience: ["dipu", "kimi"],
  status: "open",
  path: "collaboration/conversations/c9/index.md",
  createdBy: "steward",
  created: "2026-08-22T13:00:00.000Z",
  updated: "2026-08-22T13:00:00.000Z",
};

const CREATED = {
  conversation: CONVERSATION,
  event: { id: "e1", conversationId: "c9", kind: "conversation_start_requested", created: "2026-08-22T13:00:01.000Z" },
};

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startPeerConversation client", () => {
  it("POSTs the exact {peers} JSON with the in-memory Bearer header and parses the 201 response", async () => {
    const fake = stubFetch(201, CREATED);
    const result = await startPeerConversation(["kimi", "dipu"], "secret-token");
    expect(result.conversation.id).toBe("c9");
    expect("dispatch" in result).toBe(false);
    expect(fake).toHaveBeenCalledTimes(1);
    const [path, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/conversations/start-peer");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ peers: ["kimi", "dipu"] });
  });

  it("propagates a 401 as UnauthorizedError", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(startPeerConversation(["dipu", "kimi"], "stale")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("surfaces a bounded definitive server error on 4xx (NOT ambiguous — fresh retry stays allowed)", async () => {
    stubFetch(400, { error: "1 requested peer(s) are not in the local runnable set." });
    try {
      await startPeerConversation(["dipu", "zora"], "token");
      throw new Error("expected rejection");
    } catch (cause) {
      expect(cause).not.toBeInstanceOf(PeerStartAmbiguousError);
      expect(cause instanceof Error ? cause.message : "").toContain("not in the local runnable set");
    }
  });

  it("rejects a non-201 2xx as ambiguous — creation may have landed even without a 201 (P3.3 final correction)", async () => {
    const fake = stubFetch(200, CREATED);
    await expect(startPeerConversation(["dipu", "kimi"], "token")).rejects.toBeInstanceOf(PeerStartAmbiguousError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("rejects a 5xx result as ambiguous with no raw response detail (P3.3 final correction)", async () => {
    const fake = stubFetch(500, { error: "internal detail that must not leak" });
    try {
      await startPeerConversation(["dipu", "kimi"], "token");
      throw new Error("expected rejection");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PeerStartAmbiguousError);
      expect(cause instanceof Error ? cause.message : "").not.toContain("internal detail");
    }
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("classifies a malformed 201 success result as ambiguous — the request may have landed (P3.3 correction)", async () => {
    const fake = stubFetch(201, { ...CREATED, dispatch: [] });
    await expect(startPeerConversation(["dipu", "kimi"], "token")).rejects.toBeInstanceOf(PeerStartAmbiguousError);
    expect(fake).toHaveBeenCalledTimes(1);
    const fake2 = stubFetch(201, { conversation: { broken: true } });
    await expect(startPeerConversation(["dipu", "kimi"], "token")).rejects.toBeInstanceOf(PeerStartAmbiguousError);
    expect(fake2).toHaveBeenCalledTimes(1);
  });

  it("classifies network-level failure as ambiguous (no automatic retry evidence)", async () => {
    const fake = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fake);
    await expect(startPeerConversation(["dipu", "kimi"], "token")).rejects.toBeInstanceOf(PeerStartAmbiguousError);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
