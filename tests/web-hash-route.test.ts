import { describe, expect, it } from "vitest";
import {
  CONVERSATION_HASH_PREFIX,
  formatConversationHash,
  isConversationHash,
  parseHashRoute,
  routeToIntent,
  urlWithoutHash,
} from "../web/src/hash-route.js";

/**
 * C4-A: pure hash-route core for the sole durable route shape
 * `#conversation/<id>`. Deterministic parse/format, malformed/unknown
 * rejection without any request, and testable intent helpers. The module is
 * framework-free and never reads storage, local config, the vault, or the
 * network.
 */
describe("hash-route core (C4-A)", () => {
  describe("parseHashRoute", () => {
    it("treats an empty or bare hash as home", () => {
      expect(parseHashRoute("")).toEqual({ kind: "home" });
      expect(parseHashRoute("#")).toEqual({ kind: "home" });
    });

    it("parses a valid conversation hash", () => {
      expect(parseHashRoute("#conversation/20260806T000000000Z-sync")).toEqual({
        kind: "conversation",
        conversationId: "20260806T000000000Z-sync",
      });
    });

    it("accepts a hash value without the leading #", () => {
      expect(parseHashRoute("conversation/abc-123")).toEqual({ kind: "conversation", conversationId: "abc-123" });
    });

    it("rejects malformed conversation ids without a request", () => {
      expect(parseHashRoute("#conversation/")).toEqual({ kind: "invalid", hash: "#conversation/" });
      expect(parseHashRoute("#conversation/Bad ID!")).toEqual({ kind: "invalid", hash: "#conversation/Bad ID!" });
      expect(parseHashRoute("#conversation/a/b")).toEqual({ kind: "invalid", hash: "#conversation/a/b" });
      expect(parseHashRoute("#conversation")).toEqual({ kind: "invalid", hash: "#conversation" });
      expect(parseHashRoute("#conversation/ with space")).toEqual({ kind: "invalid", hash: "#conversation/ with space" });
    });

    it("rejects unknown hash shapes", () => {
      expect(parseHashRoute("#foo")).toEqual({ kind: "invalid", hash: "#foo" });
      expect(parseHashRoute("#agents")).toEqual({ kind: "invalid", hash: "#agents" });
      expect(parseHashRoute("#/x")).toEqual({ kind: "invalid", hash: "#/x" });
      expect(parseHashRoute("###")).toEqual({ kind: "invalid", hash: "###" });
    });
  });

  describe("formatConversationHash", () => {
    it("formats a valid conversation id", () => {
      expect(formatConversationHash("20260806T000000000Z-sync")).toBe("#conversation/20260806T000000000Z-sync");
      expect(formatConversationHash("abc-123").startsWith(CONVERSATION_HASH_PREFIX)).toBe(true);
    });

    it("rejects invalid ids deterministically", () => {
      expect(() => formatConversationHash("")).toThrow();
      expect(() => formatConversationHash("Bad ID!")).toThrow();
      expect(() => formatConversationHash("a/b")).toThrow();
      expect(() => formatConversationHash("-lead")).toThrow();
    });
  });

  describe("isConversationHash", () => {
    it("recognizes conversation hashes only", () => {
      expect(isConversationHash("#conversation/x-1")).toBe(true);
      expect(isConversationHash("#conversation/")).toBe(false);
      expect(isConversationHash("#conversation")).toBe(false);
      expect(isConversationHash("#foo")).toBe(false);
      expect(isConversationHash("")).toBe(false);
    });
  });

  describe("urlWithoutHash", () => {
    it("strips the fragment from a url (clearing helper)", () => {
      expect(urlWithoutHash("http://localhost:7317/#conversation/x")).toBe("http://localhost:7317/");
      expect(urlWithoutHash("http://localhost:7317/path?q=1#conversation/x")).toBe("http://localhost:7317/path?q=1");
      expect(urlWithoutHash("http://localhost:7317/#")).toBe("http://localhost:7317/");
      expect(urlWithoutHash("http://localhost:7317/")).toBe("http://localhost:7317/");
    });
  });

  describe("routeToIntent", () => {
    it("maps parsed routes to explicit intents", () => {
      expect(routeToIntent({ kind: "home" })).toEqual({ kind: "show-home" });
      expect(routeToIntent({ kind: "conversation", conversationId: "x" })).toEqual({ kind: "open-conversation", conversationId: "x" });
      expect(routeToIntent({ kind: "invalid", hash: "#foo" })).toEqual({ kind: "invalid-route", hash: "#foo" });
    });

    it("round-trips through parseHashRoute", () => {
      expect(routeToIntent(parseHashRoute(""))).toEqual({ kind: "show-home" });
      expect(routeToIntent(parseHashRoute("#conversation/abc-123"))).toEqual({ kind: "open-conversation", conversationId: "abc-123" });
      expect(routeToIntent(parseHashRoute("#bogus"))).toEqual({ kind: "invalid-route", hash: "#bogus" });
    });
  });
});
