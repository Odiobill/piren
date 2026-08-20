import { describe, expect, it } from "vitest";
import {
  buildDiscordSettingsEnvelope,
  buildTelegramSettingsEnvelope,
  parseDiscordSettingsRead,
  parseDiscordSnowflakesInput,
  parseSettingsWriteResponse,
  parseTelegramChatIdsInput,
  parseTelegramSettingsRead,
} from "../web/src/settings-transport.js";

/**
 * W5 (0.2.0 amendment §5/§5.1; ADR-0046): pure typed transport Settings
 * cores — fail-closed parsers for the redacted read projections, the
 * structural chat-id/snowflake validators (mirroring the accepted CLI
 * transport-configure contracts), the closed write intent builders, and the
 * fully-redacted write response parser. No fetch, no storage, no secrets.
 */

describe("parseTelegramChatIdsInput (structural, mirrors CLI contract)", () => {
  it("parses a comma-separated integer list, allowing negative group ids", () => {
    expect(parseTelegramChatIdsInput("123456789, -1001234567890")).toEqual({
      ok: true,
      ids: [123456789, -1001234567890],
    });
  });

  it("dedupes and rejects empty/non-numeric/float/unsafe entries", () => {
    expect(parseTelegramChatIdsInput("")).toEqual({ ok: false, error: expect.stringMatching(/required/i) });
    expect(parseTelegramChatIdsInput("123, ").ok).toBe(false);
    expect(parseTelegramChatIdsInput("abc").ok).toBe(false);
    expect(parseTelegramChatIdsInput("1.5").ok).toBe(false);
    expect(parseTelegramChatIdsInput("9007199254740993").ok).toBe(false); // > safe int
    const dedup = parseTelegramChatIdsInput("1,1,2");
    expect(dedup.ok).toBe(true);
    if (dedup.ok) expect(dedup.ids).toEqual([1, 2]);
  });
});

describe("parseDiscordSnowflakesInput (structural, mirrors CLI contract)", () => {
  it("parses 15-22 digit snowflake strings", () => {
    expect(parseDiscordSnowflakesInput("123456789012345678, 9999999999999999999999", "guild", "server")).toEqual({
      ok: true,
      ids: ["123456789012345678", "9999999999999999999999"],
    });
  });

  it("rejects short/alpha entries and empty lists unless optional", () => {
    expect(parseDiscordSnowflakesInput("", "guild", "server").ok).toBe(false);
    expect(parseDiscordSnowflakesInput("123", "guild", "server").ok).toBe(false);
    expect(parseDiscordSnowflakesInput("abc123456789012345", "guild", "server").ok).toBe(false);
    expect(parseDiscordSnowflakesInput("", "thread", "thread", { optional: true })).toEqual({ ok: true, ids: [] });
  });
});

describe("read projection parsers (fail-closed, redacted only)", () => {
  it("parses a valid telegram projection with a count, never raw ids", () => {
    const read = parseTelegramSettingsRead({
      available: true,
      telegram: { configured: true, allowedChatIds: 3, defaultAgent: "piren", feedbackEnabled: true },
    });
    expect(read).toEqual({
      available: true,
      value: { configured: true, allowedChatIds: 3, defaultAgent: "piren", feedbackEnabled: true },
    });
  });

  it("parses an unavailable telegram read with a bounded reason", () => {
    expect(parseTelegramSettingsRead({ available: false, reason: "Local config is not present." })).toEqual({
      available: false,
      reason: "Local config is not present.",
    });
  });

  it("parses a discord projection including the W5 feedback field", () => {
    const read = parseDiscordSettingsRead({
      available: true,
      discord: {
        configured: true,
        allowedGuildIds: 1,
        allowedChannelIds: 2,
        allowedThreadIds: 0,
        allowedDmUserIds: null,
        defaultAgent: "piren",
        feedbackEnabled: false,
      },
    });
    expect(read).toEqual({
      available: true,
      value: {
        configured: true,
        allowedGuildIds: 1,
        allowedChannelIds: 2,
        allowedThreadIds: 0,
        allowedDmUserIds: null,
        defaultAgent: "piren",
        feedbackEnabled: false,
      },
    });
  });

  it("fails closed on malformed projections (no raw field invention)", () => {
    expect(() => parseTelegramSettingsRead({ available: true })).toThrow();
    expect(() => parseTelegramSettingsRead({ available: true, telegram: { configured: "yes" } })).toThrow();
    expect(() => parseTelegramSettingsRead({ available: false })).toThrow();
    expect(() => parseDiscordSettingsRead({ available: true, discord: { configured: true } })).toThrow();
    expect(() => parseTelegramSettingsRead(null)).toThrow();
  });
});

describe("write response parser", () => {
  it("accepts exactly { wrote: true }", () => {
    expect(() => parseSettingsWriteResponse({ wrote: true })).not.toThrow();
  });

  it("rejects any other payload", () => {
    expect(() => parseSettingsWriteResponse({})).toThrow();
    expect(() => parseSettingsWriteResponse({ wrote: false })).toThrow();
    expect(() => parseSettingsWriteResponse({ wrote: true, token: "x" })).toThrow();
    expect(() => parseSettingsWriteResponse("ok")).toThrow();
  });
});

describe("closed write intent builders (never include unknown fields)", () => {
  it("builds the telegram envelope with the declared camelCase block", () => {
    expect(buildTelegramSettingsEnvelope({ botToken: "T", allowedChatIds: [1], defaultAgent: "a", feedbackEnabled: true })).toEqual({
      surface: "local",
      family: "telegram",
      block: { botToken: "T", allowedChatIds: [1], defaultAgent: "a", feedbackEnabled: true },
    });
  });

  it("builds the discord envelope with all four list families", () => {
    expect(
      buildDiscordSettingsEnvelope({
        botToken: "D",
        allowedGuildIds: ["1"],
        allowedChannelIds: ["2"],
        allowedThreadIds: ["3"],
        allowedDmUserIds: ["4"],
        defaultAgent: "a",
        feedbackEnabled: false,
      }),
    ).toEqual({
      surface: "local",
      family: "discord",
      block: {
        botToken: "D",
        allowedGuildIds: ["1"],
        allowedChannelIds: ["2"],
        allowedThreadIds: ["3"],
        allowedDmUserIds: ["4"],
        defaultAgent: "a",
        feedbackEnabled: false,
      },
    });
  });
});
