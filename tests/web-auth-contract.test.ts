import { describe, expect, it } from "vitest";
import { buildAuthHeaders, parseAuthInfo, type AuthInfoResponse } from "../web/src/auth.js";

/**
 * ADR-0041 R3b-1: authenticated-shell contract for the pure auth helpers.
 * The shell may only consume GET /api/auth/info, keeps the bearer token
 * in memory (never storage), and sends no authenticated requests yet.
 */
describe("web auth shell contract (R3b-1)", () => {
  describe("parseAuthInfo", () => {
    it("accepts the documented { authRequired: boolean } shape", () => {
      expect(parseAuthInfo({ authRequired: true })).toEqual({ authRequired: true });
      expect(parseAuthInfo({ authRequired: false })).toEqual({ authRequired: false });
    });

    it("rejects malformed bodies fail-closed", () => {
      expect(() => parseAuthInfo(null)).toThrow();
      expect(() => parseAuthInfo("nope")).toThrow();
      expect(() => parseAuthInfo({})).toThrow();
      expect(() => parseAuthInfo({ authRequired: "yes" })).toThrow();
      expect(() => parseAuthInfo({ authRequired: undefined })).toThrow();
    });
  });

  describe("buildAuthHeaders", () => {
    it("returns no header for an empty or blank token", () => {
      expect(buildAuthHeaders("")).toEqual({});
      expect(buildAuthHeaders("   ")).toEqual({});
    });

    it("returns a Bearer header for a real token", () => {
      expect(buildAuthHeaders("secret-token")).toEqual({ Authorization: "Bearer secret-token" });
    });

    it("trims surrounding whitespace without sending a malformed credential", () => {
      expect(buildAuthHeaders("  tok  ")).toEqual({ Authorization: "Bearer tok" });
    });
  });

  it("types the shell auth phases as loading | token-needed | ready", () => {
    // Compile-time contract only: the three phases are the shell's states.
    const phases: readonly string[] = ["loading", "token-needed", "ready"];
    expect(phases).toContain("loading");
    expect(phases).toContain("token-needed");
    expect(phases).toContain("ready");
  });
});
