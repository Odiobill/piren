import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  isLocalhostBind,
  isBearerAuthorized,
  assertAuthGate,
  resolveGatewayToken,
  generateToken,
} from "../src/gateway-auth.js";

describe("isLocalhostBind", () => {
  it("returns true for 127.0.0.1 and localhost, false for anything else", () => {
    expect(isLocalhostBind("127.0.0.1")).toBe(true);
    expect(isLocalhostBind("localhost")).toBe(true);
    expect(isLocalhostBind("0.0.0.0")).toBe(false);
    expect(isLocalhostBind("192.168.1.10")).toBe(false);
    expect(isLocalhostBind("heimdall.local")).toBe(false);
    expect(isLocalhostBind("::1")).toBe(false);
  });
});

describe("isBearerAuthorized", () => {
  it("returns true when the header matches Bearer <token>", () => {
    expect(isBearerAuthorized("Bearer abc123", "abc123")).toBe(true);
  });

  it("returns false when the token does not match", () => {
    expect(isBearerAuthorized("Bearer wrong", "abc123")).toBe(false);
  });

  it("returns false when the header is missing", () => {
    expect(isBearerAuthorized(undefined, "abc123")).toBe(false);
    expect(isBearerAuthorized(null, "abc123")).toBe(false);
    expect(isBearerAuthorized("", "abc123")).toBe(false);
  });

  it("returns false when the header lacks the Bearer scheme", () => {
    expect(isBearerAuthorized("abc123", "abc123")).toBe(false);
    expect(isBearerAuthorized("Basic abc123", "abc123")).toBe(false);
  });

  it("returns false when the token string is empty", () => {
    expect(isBearerAuthorized("Bearer ", "")).toBe(false);
    expect(isBearerAuthorized("Bearer abc", "")).toBe(false);
  });
});

describe("assertAuthGate", () => {
  it("refuses to start on a non-localhost bind without a token", () => {
    expect(() => assertAuthGate({ hostname: "0.0.0.0", token: "" })).toThrow(
      /token is required/i,
    );
    expect(() => assertAuthGate({ hostname: "192.168.1.10", token: "" })).toThrow(
      /token is required/i,
    );
  });

  it("allows a non-localhost bind when a token is present", () => {
    expect(() => assertAuthGate({ hostname: "0.0.0.0", token: "abc123" })).not.toThrow();
  });

  it("allows a localhost bind with no token (optional auth)", () => {
    expect(() => assertAuthGate({ hostname: "127.0.0.1", token: "" })).not.toThrow();
    expect(() => assertAuthGate({ hostname: "localhost", token: "" })).not.toThrow();
  });

  it("allows a localhost bind with a token present (token still enforced per request)", () => {
    expect(() => assertAuthGate({ hostname: "127.0.0.1", token: "abc123" })).not.toThrow();
  });
});

describe("generateToken", () => {
  it("produces a URL-safe base64url token from the requested byte count", () => {
    // 32 bytes -> 43 base64url chars (no padding). URL-safe: no +, /, or =.
    const token = generateToken(32);
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique tokens across calls", () => {
    const a = generateToken(32);
    const b = generateToken(32);
    expect(a).not.toBe(b);
  });

  it("uses a sensible default byte count when called with no args", () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("resolveGatewayToken", () => {
  it("prefers the CLI --token value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piren-auth-"));
    try {
      const tokenPath = join(dir, "gateway-token");
      await writeFile(tokenPath, "from-file\n");
      const result = await resolveGatewayToken({
        cliToken: "from-cli",
        envToken: "from-env",
        tokenPath,
      });
      expect(result.token).toBe("from-cli");
      expect(result.source).toBe("cli");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to PIREN_TOKEN env when no CLI token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piren-auth-"));
    try {
      const tokenPath = join(dir, "gateway-token");
      await writeFile(tokenPath, "from-file\n");
      const result = await resolveGatewayToken({
        envToken: "from-env",
        tokenPath,
      });
      expect(result.token).toBe("from-env");
      expect(result.source).toBe("env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the token file when no CLI or env token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piren-auth-"));
    try {
      const tokenPath = join(dir, "gateway-token");
      await writeFile(tokenPath, "  from-file  \n");
      const result = await resolveGatewayToken({ tokenPath });
      expect(result.token).toBe("from-file");
      expect(result.source).toBe("file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty token with source 'none' when nothing is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piren-auth-"));
    try {
      const tokenPath = join(dir, "gateway-token");
      const result = await resolveGatewayToken({ tokenPath });
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto-generates and persists a token when generate is true and none exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piren-auth-"));
    try {
      const tokenPath = join(dir, "gateway-token");
      const result = await resolveGatewayToken({ tokenPath, generate: true });
      expect(result.token).toHaveLength(43);
      expect(result.source).toBe("generated");
      // The token was persisted to disk.
      const persisted = (await readFile(tokenPath, "utf8")).trim();
      expect(persisted).toBe(result.token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does NOT auto-generate when generate is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "piren-auth-"));
    try {
      const tokenPath = join(dir, "gateway-token");
      const result = await resolveGatewayToken({ tokenPath, generate: false });
      expect(result.token).toBe("");
      expect(result.source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
