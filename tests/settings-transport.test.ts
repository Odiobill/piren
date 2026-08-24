import { describe, expect, it } from "vitest";
import {
  buildAgentModelFallbackEnvelope,
  buildDiscordSettingsEnvelope,
  buildSchedulerSettingsEnvelope,
  buildTelegramSettingsEnvelope,
  isValidContextInjectionMode,
  isValidFallbackModelId,
  isValidThinkingLevel,
  parseAgentPreferencesRead,
  parseDiscordSettingsRead,
  parseOptionalPositiveInt,
  parseSchedulerSettingsRead,
  parseSettingsWriteResponse,
  parseTelegramChatIdsInput,
  parseDiscordSnowflakesInput,
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

describe("W6 scheduler settings read parser", () => {
  it("parses the redacted scheduler projection incl. closed legacyMasterGate state (ST-1A)", () => {
    const read = parseSchedulerSettingsRead({
      available: true,
      scheduler: {
        present: true,
        legacyMasterGate: "ignored",
        automation: { inboxTasks: true, agentCron: false, scriptCron: false },
        deviceIdConfigured: true,
        pollIntervalSeconds: 15,
        staleAfterSeconds: null,
        maxConcurrentAgents: 1,
        deviceId: "thor",
      },
    });
    expect(read).toEqual({
      available: true,
      value: {
        present: true,
        legacyMasterGate: "ignored",
        automation: { inboxTasks: true, agentCron: false, scriptCron: false },
        deviceIdConfigured: true,
        pollIntervalSeconds: 15,
        staleAfterSeconds: null,
        maxConcurrentAgents: 1,
        deviceId: "thor",
      },
    });
  });

  it("fails closed on malformed scheduler projections", () => {
    expect(() => parseSchedulerSettingsRead({ available: true })).toThrow();
    expect(() => parseSchedulerSettingsRead({ available: true, scheduler: { enabled: true } })).toThrow();
    expect(() =>
      parseSchedulerSettingsRead({
        available: true,
        scheduler: {
          present: true,
          legacyMasterGate: "sometimes",
          automation: { inboxTasks: false, agentCron: false, scriptCron: false },
          deviceIdConfigured: false,
          pollIntervalSeconds: null,
          staleAfterSeconds: null,
          maxConcurrentAgents: null,
          deviceId: null,
        },
      }),
    ).toThrow();
    expect(() => parseSchedulerSettingsRead({ available: false })).toThrow();
  });
});

describe("W6 agent preferences read parser", () => {
  it("parses the full editable agent-preference projection", () => {
    const read = parseAgentPreferencesRead({
      available: true,
      model: { id: "anthropic/claude-sonnet-4-6", thinking: "high" },
      modelFallback: { declared: true, autoSwitch: true, modelCount: 2, models: ["a/b", "c/d"] },
      contextInjection: { mode: "session_start_only" },
      selfImprovement: { autoNudge: true, reviewLoopEnabled: true, reviewLoop: { intervalTurns: 10, recentMessages: 20, timeoutMs: 120000 } },
    });
    expect(read).toEqual({
      available: true,
      value: {
        model: { id: "anthropic/claude-sonnet-4-6", thinking: "high" },
        modelFallback: { declared: true, autoSwitch: true, modelCount: 2, models: ["a/b", "c/d"] },
        contextInjection: { mode: "session_start_only" },
        selfImprovement: { autoNudge: true, reviewLoopEnabled: true, reviewLoop: { intervalTurns: 10, recentMessages: 20, timeoutMs: 120000 } },
      },
    });
  });

  it("accepts absent optional booleans represented as null in a redacted projection", () => {
    const read = parseAgentPreferencesRead({
      available: true,
      model: { id: null, thinking: null },
      modelFallback: { declared: false, autoSwitch: null, modelCount: 0, models: [] },
      contextInjection: { mode: null },
      selfImprovement: {
        autoNudge: null,
        reviewLoopEnabled: null,
        reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null },
      },
    });
    expect(read).toEqual({
      available: true,
      value: {
        model: { id: null, thinking: null },
        modelFallback: { declared: false, autoSwitch: null, modelCount: 0, models: [] },
        contextInjection: { mode: null },
        selfImprovement: {
          autoNudge: null,
          reviewLoopEnabled: null,
          reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null },
        },
      },
    });
  });

  it("still rejects invalid non-null boolean types", () => {
    expect(() =>
      parseAgentPreferencesRead({
        available: true,
        model: { id: null, thinking: null },
        modelFallback: { declared: false, autoSwitch: "yes", modelCount: 0, models: [] },
        contextInjection: { mode: null },
        selfImprovement: {
          autoNudge: null,
          reviewLoopEnabled: null,
          reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null },
        },
      }),
    ).toThrow();
    expect(() =>
      parseAgentPreferencesRead({
        available: true,
        model: { id: null, thinking: null },
        modelFallback: { declared: false, autoSwitch: null, modelCount: 0, models: [] },
        contextInjection: { mode: null },
        selfImprovement: {
          autoNudge: 1,
          reviewLoopEnabled: "true",
          reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null },
        },
      }),
    ).toThrow();
  });

  it("independently rejects an invalid non-null reviewLoopEnabled when every other optional boolean is valid", () => {
    // The combined projection above short-circuits at the invalid
    // `autoNudge`, so rejection of invalid non-null `reviewLoopEnabled`
    // needs its own pin with a otherwise-valid projection.
    expect(() =>
      parseAgentPreferencesRead({
        available: true,
        model: { id: null, thinking: null },
        modelFallback: { declared: false, autoSwitch: null, modelCount: 0, models: [] },
        contextInjection: { mode: null },
        selfImprovement: {
          autoNudge: null,
          reviewLoopEnabled: "true",
          reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null },
        },
      }),
    ).toThrow();
  });

  it("fails closed on malformed agent projections", () => {
    expect(() => parseAgentPreferencesRead({ available: true })).toThrow();
    expect(() => parseAgentPreferencesRead({ available: true, model: { id: 1 } })).toThrow();
    expect(() => parseAgentPreferencesRead({ available: true, model: {}, modelFallback: {}, contextInjection: {}, selfImprovement: {} })).toThrow();
  });
});

describe("W6 validators", () => {
  it("validates thinking levels and context-injection modes", () => {
    expect(isValidThinkingLevel("low")).toBe(true);
    expect(isValidThinkingLevel("minimal")).toBe(true);
    expect(isValidThinkingLevel("xhigh")).toBe(true);
    expect(isValidThinkingLevel("max")).toBe(true);
    expect(isValidThinkingLevel("banana")).toBe(false);
    expect(isValidContextInjectionMode("per_turn")).toBe(true);
    expect(isValidContextInjectionMode("always")).toBe(false);
  });

  it("validates fallback model ids against the delivered grammar", () => {
    expect(isValidFallbackModelId("openai/gpt-4o")).toBe(true);
    expect(isValidFallbackModelId("ollama/llama3.1:8b")).toBe(true);
    expect(isValidFallbackModelId("gpt-4o")).toBe(false);
    expect(isValidFallbackModelId("OpenAI/gpt-4o")).toBe(false);
  });

  it("parses optional positive integers (blank = null, invalid = invalid)", () => {
    expect(parseOptionalPositiveInt("")).toBeNull();
    expect(parseOptionalPositiveInt("10")).toBe(10);
    expect(parseOptionalPositiveInt("0")).toBe("invalid");
    expect(parseOptionalPositiveInt("-3")).toBe("invalid");
    expect(parseOptionalPositiveInt("1.5")).toBe("invalid");
  });
});

describe("W6 closed write intent builders", () => {
  it("builds the scheduler envelope with snake_case automation keys", () => {
    expect(buildSchedulerSettingsEnvelope({ automation: { inbox_tasks: true } })).toEqual({
      surface: "local",
      family: "scheduler",
      block: { automation: { inbox_tasks: true } },
    });
  });

  it("builds the model-fallback envelope with confirmAutoSwitch only when true", () => {
    expect(buildAgentModelFallbackEnvelope("kimi", { autoSwitch: true }, true)).toEqual({
      surface: "agent",
      agent: "kimi",
      family: "model-fallback",
      block: { autoSwitch: true },
      confirmAutoSwitch: true,
    });
    expect(buildAgentModelFallbackEnvelope("kimi", { autoSwitch: false }, false)).toEqual({
      surface: "agent",
      agent: "kimi",
      family: "model-fallback",
      block: { autoSwitch: false },
    });
  });
});
