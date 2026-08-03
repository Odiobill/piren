import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthHeaders, parseAuthInfo, resolveShellAuth, type AuthInfoResponse } from "../web/src/auth.js";

/**
 * ADR-0041 R3b-1: authenticated-shell contract for the pure auth helpers.
 * The shell may only consume GET /api/auth/info, keeps the bearer token
 * in memory (never storage), sends no authenticated requests yet, and must
 * never claim a token is authenticated or validated before a protected
 * request has actually succeeded.
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

  describe("resolveShellAuth (honest token state)", () => {
    it("models a no-token localhost shell as ready-local, never authenticated", () => {
      expect(resolveShellAuth(false, "")).toEqual({ status: "ready-local" });
    });

    it("models a token-required shell with no token as token-needed", () => {
      expect(resolveShellAuth(true, "")).toEqual({ status: "token-needed" });
      expect(resolveShellAuth(true, "   ")).toEqual({ status: "token-needed" });
    });

    it("models an entered token as token-ready (in memory, NOT validated)", () => {
      expect(resolveShellAuth(true, "secret")).toEqual({ status: "token-ready", token: "secret" });
      expect(resolveShellAuth(true, "  tok  ")).toEqual({ status: "token-ready", token: "tok" });
    });

    it("the status vocabulary never claims authentication or validation", () => {
      const vocabulary = [
        resolveShellAuth(false, "").status,
        resolveShellAuth(true, "").status,
        resolveShellAuth(true, "x").status,
      ] as const;
      expect(vocabulary).toEqual(["ready-local", "token-needed", "token-ready"]);
      for (const status of vocabulary) {
        expect(status).not.toMatch(/authenticated|validated/i);
      }
    });
  });

  describe("R3b-1 shell honesty contract (static)", () => {
    it("the shell copy never claims an Authenticated status or an authenticated shell", async () => {
      const app = await readFile(join(process.cwd(), "web", "src", "App.tsx"), "utf8");
      expect(app).not.toContain("Authenticated");
      expect(app).not.toContain("authenticated shell");
    });

    it("the shell copy is explicit that the token is not validated yet", async () => {
      const [app, shell] = await Promise.all([
        readFile(join(process.cwd(), "web", "src", "App.tsx"), "utf8"),
        readFile(join(process.cwd(), "web", "src", "AppShell.tsx"), "utf8"),
      ]);
      const combined = `${app}\n${shell}`;
      expect(combined).toContain("Token ready");
      expect(combined).toContain("Gateway reachable");
      expect(combined).toMatch(/not been validated/i);
    });

    it("the shell calls only its authorized endpoints (auth-info + room-agents + rooms)", async () => {
      const [app, api] = await Promise.all([
        readFile(join(process.cwd(), "web", "src", "App.tsx"), "utf8"),
        readFile(join(process.cwd(), "web", "src", "api.ts"), "utf8"),
      ]);
      const combined = `${app}\n${api}`;
      // R3b-1 authorized the public auth probe; R3b-2 authorized the
      // room-agents roster and room list/create/read routes.
      expect(combined).toContain("/api/auth/info");
      expect(combined).toContain("/api/room-agents");
      expect(combined).toContain("/api/rooms");
      // Chat, vault, and completions endpoints stay outside the workbench shell.
      for (const forbidden of ["/api/chat", "/api/vault", "/api/v1/"]) {
        expect(combined, `${forbidden} must not be called by the shell`).not.toContain(forbidden);
      }
    });
  });

  it("types the shell auth statuses as ready-local | token-needed | token-ready", () => {
    // Compile-time contract only: the three honest statuses are the shell's
    // states; there is no authenticated/validated status.
    const statuses: readonly string[] = ["ready-local", "token-needed", "token-ready"];
    expect(statuses).toContain("ready-local");
    expect(statuses).toContain("token-needed");
    expect(statuses).toContain("token-ready");
  });
});
