import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDiscordSettings,
  fetchTelegramSettings,
  saveDiscordSettings,
  saveTelegramSettings,
  SettingsHttpError,
  UnauthorizedError,
} from "../web/src/api.js";

/**
 * W5 — typed transport Settings API client over the EXISTING gateway auth
 * gate: in-memory Bearer header, UnauthorizedError on 401, fail-closed
 * redacted read parsing, fully-redacted write responses, and bounded typed
 * write errors (invalid/conflict/server). No storage, no token in the URL.
 */

function stubFetch(status: number, json: unknown): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => json,
  }));
  vi.stubGlobal("fetch", fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegram/discord settings reads", () => {
  it("sends the in-memory Bearer header and parses the redacted projection", async () => {
    const fake = stubFetch(200, { available: true, telegram: { configured: true, allowedChatIds: 2, defaultAgent: null, feedbackEnabled: true } });
    const read = await fetchTelegramSettings("secret-token");
    expect(read).toEqual({ available: true, value: { configured: true, allowedChatIds: 2, defaultAgent: null, feedbackEnabled: true } });
    expect(fake).toHaveBeenCalledTimes(1);
    const [path, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/settings/telegram");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("parses an unavailable read state", async () => {
    stubFetch(200, { available: false, reason: "Local config is not present." });
    expect(await fetchTelegramSettings("T")).toEqual({ available: false, reason: "Local config is not present." });
  });

  it("surfaces 401 through UnauthorizedError and rejects bad payloads", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(fetchDiscordSettings("bad")).rejects.toBeInstanceOf(UnauthorizedError);
    stubFetch(200, { available: true }); // missing discord projection
    await expect(fetchDiscordSettings("T")).rejects.toThrow();
  });
});

describe("telegram/discord settings writes", () => {
  it("POSTs the closed envelope and validates the redacted write response", async () => {
    const fake = stubFetch(200, { wrote: true });
    await saveTelegramSettings({ botToken: "T", allowedChatIds: [1] }, "secret-token");
    const [path, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/settings/telegram");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body as string)).toEqual({ surface: "local", family: "telegram", block: { botToken: "T", allowedChatIds: [1] } });
  });

  it("maps 400 -> invalid, 409 -> conflict, 500 -> server, network -> network (bounded, never the raw body)", async () => {
    stubFetch(400, { error: "secret" });
    await expect(saveTelegramSettings({ defaultAgent: "x" }, "T")).rejects.toMatchObject({ kind: "invalid" });
    stubFetch(409, { error: "secret" });
    await expect(saveDiscordSettings({ defaultAgent: "x" }, "T")).rejects.toMatchObject({ kind: "conflict" });
    stubFetch(500, { error: "secret" });
    await expect(saveTelegramSettings({ defaultAgent: "x" }, "T")).rejects.toMatchObject({ kind: "server" });
    const network = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", network);
    await expect(saveTelegramSettings({ defaultAgent: "x" }, "T")).rejects.toMatchObject({ kind: "network" });
    // The error is a typed SettingsHttpError, never a raw secret echo.
    try {
      stubFetch(400, { error: "secret" });
      await saveTelegramSettings({ defaultAgent: "x" }, "T");
    } catch (cause) {
      expect(cause).toBeInstanceOf(SettingsHttpError);
      expect(String(cause)).not.toContain("secret");
    }
  });

  it("surfaces 401 through UnauthorizedError on writes too", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(saveTelegramSettings({ defaultAgent: "x" }, "bad")).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
