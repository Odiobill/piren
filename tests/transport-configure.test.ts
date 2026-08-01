import { describe, expect, it } from "vitest";
import {
  redactSecret,
  parseTelegramChatIds,
  parseDiscordSnowflakes,
  buildTelegramConfigBlock,
  buildDiscordConfigBlock,
  mergeTransportIntoConfig,
  renderRedactedPreview,
  runTransportConfigure,
  type TransportConfigureIo,
} from "../src/transport-configure.js";
import type { WizardPrompt } from "../src/prompt.js";

// ---------------------------------------------------------------------------
// Fake prompt + IO helpers
// ---------------------------------------------------------------------------

interface FakePromptCalls {
  text: Array<{ message: string; defaultValue?: string }>;
  secret: string[];
  confirm: Array<{ message: string; defaultValue?: boolean }>;
  select: Array<{ message: string; options: readonly string[]; defaultIndex?: number }>;
}

function fakePrompt(script: {
  textAnswers?: Array<string | undefined>;
  secretAnswers?: string[];
  confirmAnswers?: boolean[];
  selectAnswers?: number[];
}): { prompt: WizardPrompt; calls: FakePromptCalls } {
  const textQ = [...(script.textAnswers ?? [])];
  const secretQ = [...(script.secretAnswers ?? [])];
  const confirmQ = [...(script.confirmAnswers ?? [])];
  const selectQ = [...(script.selectAnswers ?? [])];
  const calls: FakePromptCalls = { text: [], secret: [], confirm: [], select: [] };
  const prompt: WizardPrompt = {
    async text(message: string, defaultValue?: string) {
      calls.text.push(defaultValue === undefined ? { message } : { message, defaultValue });
      const answer = textQ.shift();
      if (answer === undefined) return defaultValue ?? "";
      return answer;
    },
    async secret(message: string) {
      calls.secret.push(message);
      return secretQ.shift() ?? "";
    },
    async confirm(message: string, defaultValue?: boolean) {
      calls.confirm.push(defaultValue === undefined ? { message } : { message, defaultValue });
      const answer = confirmQ.shift();
      return answer ?? defaultValue ?? false;
    },
    async select(message: string, options: readonly string[], defaultIndex?: number) {
      calls.select.push(defaultIndex === undefined ? { message, options } : { message, options, defaultIndex });
      const answer = selectQ.shift();
      return answer ?? defaultIndex ?? 0;
    },
    async list(_message: string, defaults?: string[]) {
      return defaults ?? [];
    },
  };
  return { prompt, calls };
}

function fakeIo(existing?: string): { io: TransportConfigureIo; writes: Array<{ path: string; content: string }> } {
  const writes: Array<{ path: string; content: string }> = [];
  const io: TransportConfigureIo = {
    async readConfig() {
      return existing ?? null;
    },
    async writeConfigAtomic(path: string, content: string) {
      writes.push({ path, content });
    },
  };
  return { io, writes };
}

const RUNNABLE = ["dipu", "kimi", "piren"];

// ---------------------------------------------------------------------------
// redactSecret
// ---------------------------------------------------------------------------

describe("redactSecret", () => {
  it("never includes any token characters", () => {
    const token = "123456:ABC-secret-token-xyz";
    const redacted = redactSecret(token);
    expect(redacted).not.toContain("123456");
    expect(redacted).not.toContain("ABC");
    expect(redacted).not.toContain("xyz");
    expect(redacted).toContain("redacted");
  });

  it("reports the token length without revealing contents", () => {
    expect(redactSecret("abcdefghij")).toBe("<redacted: 10 chars>");
  });
});

// ---------------------------------------------------------------------------
// parseTelegramChatIds
// ---------------------------------------------------------------------------

describe("parseTelegramChatIds", () => {
  it("parses comma-separated integers, including negative group ids", () => {
    const result = parseTelegramChatIds("123456789, -1001234567890");
    expect(result).toEqual({ ok: true, ids: [123456789, -1001234567890] });
  });

  it("dedupes repeated ids preserving order", () => {
    const result = parseTelegramChatIds("5, 3, 5");
    expect(result).toEqual({ ok: true, ids: [5, 3] });
  });

  it("rejects empty input", () => {
    const result = parseTelegramChatIds("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one/i);
  });

  it("rejects non-numeric entries", () => {
    const result = parseTelegramChatIds("123, alice");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("alice");
  });

  it("rejects floats and empty entries", () => {
    expect(parseTelegramChatIds("1.5").ok).toBe(false);
    expect(parseTelegramChatIds("1,,2").ok).toBe(false);
  });

  it("rejects numbers beyond the safe integer range", () => {
    expect(parseTelegramChatIds("99999999999999999999").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDiscordSnowflakes
// ---------------------------------------------------------------------------

describe("parseDiscordSnowflakes", () => {
  it("parses comma-separated snowflakes as strings", () => {
    const result = parseDiscordSnowflakes("111111111111111111, 222222222222222222", "allowed_guild_ids", "server (guild)");
    expect(result).toEqual({ ok: true, ids: ["111111111111111111", "222222222222222222"] });
  });

  it("rejects short or non-digit input with field-specific guidance", () => {
    const result = parseDiscordSnowflakes("12345", "allowed_guild_ids", "server (guild)");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("allowed_guild_ids");
      expect(result.error).toMatch(/server \(guild\)/);
      expect(result.error).toMatch(/not a user id/i);
    }
  });

  it("distinguishes channel and thread fields in errors", () => {
    const channel = parseDiscordSnowflakes("abc", "allowed_channel_ids", "channel");
    expect(channel.ok).toBe(false);
    if (!channel.ok) expect(channel.error).toContain("allowed_channel_ids");
    const thread = parseDiscordSnowflakes("abc", "allowed_thread_ids", "thread");
    expect(thread.ok).toBe(false);
    if (!thread.ok) expect(thread.error).toContain("allowed_thread_ids");
  });

  it("allows blank input only when optional", () => {
    expect(parseDiscordSnowflakes("", "allowed_thread_ids", "thread", { optional: true })).toEqual({ ok: true, ids: [] });
    expect(parseDiscordSnowflakes("", "allowed_guild_ids", "server (guild)").ok).toBe(false);
  });

  it("treats 'none' as an explicit clear for optional lists", () => {
    expect(parseDiscordSnowflakes("none", "allowed_thread_ids", "thread", { optional: true })).toEqual({ ok: true, ids: [] });
  });
});

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

describe("buildTelegramConfigBlock", () => {
  it("builds a typed telegram block with numeric chat ids", () => {
    const block = buildTelegramConfigBlock({
      botToken: "token-abc",
      chatIds: [123, -100],
      feedback: { enabled: true, reaction_on_receive: "👀", reaction_on_complete: "👍", typing_while_working: true },
      defaultAgent: "kimi",
    });
    expect(block.bot_token).toBe("token-abc");
    expect(block.allowed_chat_ids).toEqual([123, -100]);
    expect(block.default_agent).toBe("kimi");
    expect(block.feedback).toEqual({
      enabled: true,
      reaction_on_receive: "👀",
      reaction_on_complete: "👍",
      typing_while_working: true,
    });
  });
});

describe("buildDiscordConfigBlock", () => {
  it("builds a typed discord block with string snowflakes", () => {
    const block = buildDiscordConfigBlock({
      botToken: "discord-token",
      guildIds: ["111111111111111111"],
      channelIds: ["222222222222222222"],
      threadIds: ["333333333333333333"],
      feedback: { enabled: true, reaction_on_receive: "👀", reaction_on_complete: "✅", typing_while_working: false },
      defaultAgent: "piren",
    });
    expect(block.allowed_guild_ids).toEqual(["111111111111111111"]);
    expect(block.allowed_channel_ids).toEqual(["222222222222222222"]);
    expect(block.allowed_thread_ids).toEqual(["333333333333333333"]);
    expect(block.feedback?.typing_while_working).toBe(false);
  });

  it("omits allowed_thread_ids entirely when no threads are configured", () => {
    const block = buildDiscordConfigBlock({
      botToken: "discord-token",
      guildIds: ["111111111111111111"],
      channelIds: ["222222222222222222"],
      threadIds: [],
      feedback: { enabled: false },
      defaultAgent: "piren",
    });
    expect("allowed_thread_ids" in block).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeTransportIntoConfig
// ---------------------------------------------------------------------------

describe("mergeTransportIntoConfig", () => {
  it("writes into an empty config", () => {
    const merged = mergeTransportIntoConfig("", "telegram", {
      bot_token: "tok",
      allowed_chat_ids: [1],
      default_agent: "piren",
    });
    expect(merged).toContain("telegram:");
    expect(merged).toContain("bot_token: tok");
    expect(merged).toContain("- 1");
  });

  it("preserves unrelated top-level keys", () => {
    const existing = [
      "vault_root: /mnt/nas/Piren",
      "allowed_agents:",
      "  - kimi",
      "scheduler:",
      "  poll_interval_seconds: 30",
      "alert_mirror:",
      "  enabled: true",
      "",
    ].join("\n");
    const merged = mergeTransportIntoConfig(existing, "telegram", {
      bot_token: "tok",
      allowed_chat_ids: [1],
      default_agent: "kimi",
    });
    expect(merged).toContain("vault_root: /mnt/nas/Piren");
    expect(merged).toContain("- kimi");
    expect(merged).toContain("poll_interval_seconds: 30");
    expect(merged).toContain("enabled: true");
    expect(merged).toContain("telegram:");
  });

  it("preserves unprompted transport fields on a re-run", () => {
    const existing = [
      "discord:",
      '  bot_token: "old-token"',
      '  application_id: "999888777"',
      '  install_url: "https://discord.com/oauth2/authorize?client_id=999888777"',
      '  allowed_guild_ids:',
      '    - "111111111111111111"',
      "",
    ].join("\n");
    const merged = mergeTransportIntoConfig(existing, "discord", {
      bot_token: "new-token",
      allowed_guild_ids: ["444444444444444444"],
      allowed_channel_ids: ["555555555555555555"],
      default_agent: "kimi",
    });
    expect(merged).toContain("bot_token: new-token");
    expect(merged).not.toContain("old-token");
    expect(merged).toContain("application_id: \"999888777\"");
    expect(merged).toContain("install_url: https://discord.com/oauth2/authorize?client_id=999888777");
    expect(merged).toContain('"444444444444444444"');
    expect(merged).not.toContain("111111111111111111");
  });

  it("preserves the other transport block untouched", () => {
    const existing = [
      "discord:",
      '  bot_token: "discord-token"',
      '  allowed_guild_ids:',
      '    - "111111111111111111"',
      "",
    ].join("\n");
    const merged = mergeTransportIntoConfig(existing, "telegram", {
      bot_token: "tg",
      allowed_chat_ids: [7],
      default_agent: "kimi",
    });
    expect(merged).toContain("bot_token: discord-token");
    expect(merged).toContain('"111111111111111111"');
    expect(merged).toContain("telegram:");
  });
});

// ---------------------------------------------------------------------------
// renderRedactedPreview
// ---------------------------------------------------------------------------

describe("renderRedactedPreview", () => {
  it("shows the block with a redacted token", () => {
    const preview = renderRedactedPreview("telegram", {
      bot_token: "super-secret-token",
      allowed_chat_ids: [123456789],
      default_agent: "kimi",
    });
    expect(preview).not.toContain("super-secret-token");
    expect(preview).toContain("<redacted: 18 chars>");
    expect(preview).toContain("123456789");
    expect(preview).toContain("kimi");
    expect(preview).toContain("telegram:");
  });
});

// ---------------------------------------------------------------------------
// runTransportConfigure (runner with fake prompt + fake io)
// ---------------------------------------------------------------------------

describe("runTransportConfigure: telegram", () => {
  it("guides a fresh configuration and writes merged yaml", async () => {
    const { prompt } = fakePrompt({
      secretAnswers: ["123456:tg-token"],
      textAnswers: ["123456789, -1001234567890", undefined, undefined],
      confirmAnswers: [true, true, true],
      selectAnswers: [2],
    });
    const { io, writes } = fakeIo(null as unknown as string);

    const result = await runTransportConfigure(prompt, "telegram", {
      configPath: "/home/x/.config/piren/config.yml",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(result.wrote).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(writes).toHaveLength(1);
    const content = writes[0]!.content;
    expect(content).toContain("bot_token: 123456:tg-token");
    expect(content).toContain("- 123456789");
    expect(content).toContain("- -1001234567890");
    expect(content).toContain("default_agent: piren");
    expect(content).toContain("reaction_on_complete: 👍");
    expect(result.validation?.status).toBe("ok");
  });

  it("restricts the default-agent menu to the runnable set", async () => {
    const { prompt, calls } = fakePrompt({
      secretAnswers: ["tok"],
      textAnswers: ["42"],
      confirmAnswers: [true, true, true],
      selectAnswers: [0],
    });
    const { io } = fakeIo(null as unknown as string);

    await runTransportConfigure(prompt, "telegram", {
      configPath: "/cfg",
      runnableAgents: ["kimi", "piren"],
      io,
      log: () => {},
    });

    expect(calls.select).toHaveLength(1);
    expect(calls.select[0]!.options).toEqual(["kimi", "piren"]);
  });

  it("never prints the token in logs or the preview", async () => {
    const { prompt } = fakePrompt({
      secretAnswers: ["unique-token-9f8e7d"],
      textAnswers: ["42"],
      confirmAnswers: [true, true, true],
      selectAnswers: [0],
    });
    const { io } = fakeIo(null as unknown as string);
    const logs: string[] = [];

    await runTransportConfigure(prompt, "telegram", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: (m) => logs.push(m),
    });

    const all = logs.join("\n");
    expect(all).not.toContain("unique-token-9f8e7d");
    expect(all).toContain("<redacted:");
  });

  it("leaves the config unchanged when the write is not confirmed", async () => {
    const existing = "vault_root: /v\n";
    const { prompt } = fakePrompt({
      secretAnswers: ["tok"],
      textAnswers: ["42"],
      confirmAnswers: [true, true, false],
      selectAnswers: [0],
    });
    const { io, writes } = fakeIo(existing);

    const result = await runTransportConfigure(prompt, "telegram", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(result.wrote).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("offers to keep an existing token without a secret prompt", async () => {
    const existing = [
      "telegram:",
      '  bot_token: "existing-token"',
      "  allowed_chat_ids:",
      "    - 777",
      "  default_agent: dipu",
      "",
    ].join("\n");
    const { prompt, calls } = fakePrompt({
      confirmAnswers: [true, true, true, true],
      textAnswers: [undefined, undefined, undefined],
      selectAnswers: [0],
    });
    const { io, writes } = fakeIo(existing);

    await runTransportConfigure(prompt, "telegram", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(calls.secret).toHaveLength(0);
    expect(writes[0]!.content).toContain("bot_token: existing-token");
    // Existing ids and default agent are offered as defaults.
    expect(calls.text[0]!.defaultValue).toBe("777");
    expect(calls.select[0]!.defaultIndex).toBe(0);
  });

  it("re-prompts on invalid id input instead of writing garbage", async () => {
    const { prompt, calls } = fakePrompt({
      secretAnswers: ["tok"],
      textAnswers: ["not-a-number", "42"],
      confirmAnswers: [true, true, true],
      selectAnswers: [0],
    });
    const { io, writes } = fakeIo(null as unknown as string);

    await runTransportConfigure(prompt, "telegram", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(calls.text.filter((c) => c.message.toLowerCase().includes("chat"))).toHaveLength(2);
    expect(writes[0]!.content).toContain("- 42");
  });

  it("refuses an empty token and writes nothing", async () => {
    const { prompt } = fakePrompt({ secretAnswers: ["   "] });
    const { io, writes } = fakeIo(null as unknown as string);

    await expect(
      runTransportConfigure(prompt, "telegram", {
        configPath: "/cfg",
        runnableAgents: RUNNABLE,
        io,
        log: () => {},
      }),
    ).rejects.toThrow(/bot token is required/i);
    expect(writes).toHaveLength(0);
  });

  it("fails before prompting when no runnable agents exist", async () => {
    const { prompt, calls } = fakePrompt({});
    const { io, writes } = fakeIo(null as unknown as string);

    await expect(
      runTransportConfigure(prompt, "telegram", {
        configPath: "/cfg",
        runnableAgents: [],
        io,
        log: () => {},
      }),
    ).rejects.toThrow(/runnable/i);
    expect(calls.secret).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("refuses to run against an unparseable existing config instead of clobbering it", async () => {
    const { prompt, calls } = fakePrompt({});
    const { io, writes } = fakeIo("{{{ not yaml");

    await expect(
      runTransportConfigure(prompt, "telegram", {
        configPath: "/cfg",
        runnableAgents: RUNNABLE,
        io,
        log: () => {},
      }),
    ).rejects.toThrow(/not parseable|could not be parsed/i);
    expect(calls.secret).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("refuses when the existing config is not a YAML mapping", async () => {
    const { prompt } = fakePrompt({});
    const { io, writes } = fakeIo("- just\n- a\n- list\n");

    await expect(
      runTransportConfigure(prompt, "discord", {
        configPath: "/cfg",
        runnableAgents: RUNNABLE,
        io,
        log: () => {},
      }),
    ).rejects.toThrow(/not parseable|could not be parsed/i);
    expect(writes).toHaveLength(0);
  });
});

describe("runTransportConfigure: discord", () => {
  it("guides a fresh configuration with typed guild/channel/thread ids", async () => {
    const { prompt } = fakePrompt({
      secretAnswers: ["discord-token"],
      textAnswers: [
        "111111111111111111",
        "222222222222222222",
        "333333333333333333",
        undefined,
        undefined,
      ],
      confirmAnswers: [true, true, true],
      selectAnswers: [1],
    });
    const { io, writes } = fakeIo(null as unknown as string);

    const result = await runTransportConfigure(prompt, "discord", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(result.wrote).toBe(true);
    const content = writes[0]!.content;
    expect(content).toContain('"111111111111111111"');
    expect(content).toContain('"222222222222222222"');
    expect(content).toContain('"333333333333333333"');
    expect(content).toContain("default_agent: kimi");
    expect(content).toContain("reaction_on_complete: ✅");
    expect(result.validation?.status).toBe("ok");
  });

  it("omits thread ids when left blank on a fresh config", async () => {
    const { prompt } = fakePrompt({
      secretAnswers: ["discord-token"],
      textAnswers: ["111111111111111111", "222222222222222222", "", undefined, undefined],
      confirmAnswers: [true, true, true],
      selectAnswers: [0],
    });
    const { io, writes } = fakeIo(null as unknown as string);

    await runTransportConfigure(prompt, "discord", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(writes[0]!.content).not.toContain("allowed_thread_ids");
  });

  it("'none' clears previously configured thread ids", async () => {
    const existing = [
      "discord:",
      '  bot_token: "old"',
      '  allowed_guild_ids:',
      '    - "111111111111111111"',
      '  allowed_channel_ids:',
      '    - "222222222222222222"',
      '  allowed_thread_ids:',
      '    - "333333333333333333"',
      "",
    ].join("\n");
    const { prompt } = fakePrompt({
      confirmAnswers: [true, true, true, true],
      textAnswers: [undefined, undefined, "none", undefined, undefined],
      selectAnswers: [0],
    });
    const { io, writes } = fakeIo(existing);

    await runTransportConfigure(prompt, "discord", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    expect(writes[0]!.content).not.toContain("allowed_thread_ids");
    expect(writes[0]!.content).not.toContain("333333333333333333");
  });

  it("rejects a user-id-shaped mistake guidance on guild ids", async () => {
    const { prompt, calls } = fakePrompt({
      secretAnswers: ["discord-token"],
      textAnswers: ["not-digits", "111111111111111111", "222222222222222222", ""],
      confirmAnswers: [true, true, true],
      selectAnswers: [0],
    });
    const { io } = fakeIo(null as unknown as string);
    const logs: string[] = [];

    await runTransportConfigure(prompt, "discord", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: (m) => logs.push(m),
    });

    expect(calls.text.filter((c) => c.message.toLowerCase().includes("guild") || c.message.toLowerCase().includes("server")).length).toBeGreaterThanOrEqual(2);
    expect(logs.join("\n")).toMatch(/not a user id/i);
  });

  it("never asks for Discord DM user ids in this slice", async () => {
    const { prompt, calls } = fakePrompt({
      secretAnswers: ["discord-token"],
      textAnswers: ["111111111111111111", "222222222222222222", ""],
      confirmAnswers: [true, true, true],
      selectAnswers: [0],
    });
    const { io } = fakeIo(null as unknown as string);

    await runTransportConfigure(prompt, "discord", {
      configPath: "/cfg",
      runnableAgents: RUNNABLE,
      io,
      log: () => {},
    });

    const allMessages = [...calls.text.map((c) => c.message), ...calls.confirm.map((c) => c.message)].join("\n").toLowerCase();
    expect(allMessages).not.toContain("dm");
    expect(allMessages).not.toContain("direct message");
    expect(allMessages).not.toContain("user id");
  });
});
