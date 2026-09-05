// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TelegramSettingsForm } from "../web/src/TelegramSettingsForm.js";
import { DiscordSettingsForm } from "../web/src/DiscordSettingsForm.js";
import { SchedulerSettingsForm } from "../web/src/SchedulerSettingsForm.js";
import { AgentPreferencesForm } from "../web/src/AgentPreferencesForm.js";
import {
  fetchTelegramSettings,
  fetchDiscordSettings,
  saveTelegramSettings,
  saveDiscordSettings,
  fetchConversationAgents,
  fetchSchedulerSettings,
  saveSchedulerSettings,
  fetchAgentPreferences,
  saveAgentModelFallback,
  saveAgentSelfImprovement,
  SettingsHttpError,
  UnauthorizedError,
} from "../web/src/api.js";

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchTelegramSettings: vi.fn(),
    fetchDiscordSettings: vi.fn(),
    saveTelegramSettings: vi.fn(),
    saveDiscordSettings: vi.fn(),
    fetchConversationAgents: vi.fn(),
    fetchSchedulerSettings: vi.fn(),
    saveSchedulerSettings: vi.fn(),
    fetchAgentPreferences: vi.fn(),
    saveAgentModelFallback: vi.fn(),
    saveAgentSelfImprovement: vi.fn(),
  };
});

const mockedTelegramFetch = vi.mocked(fetchTelegramSettings);
const mockedFetchConversationAgents = vi.mocked(fetchConversationAgents);
const mockedDiscordFetch = vi.mocked(fetchDiscordSettings);
const mockedTelegramSave = vi.mocked(saveTelegramSettings);
const mockedDiscordSave = vi.mocked(saveDiscordSettings);

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderTelegram(overrides: Record<string, unknown> = {}): Promise<ReturnType<typeof vi.fn>> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onUnauthorized = vi.fn();
  const onValidated = vi.fn();
  await act(async () => {
    root.render(createElement(TelegramSettingsForm, { token: "T", onUnauthorized, onValidated, ...overrides }));
  });
  await flush();
  return onUnauthorized;
}

function inputByClass(cls: string): HTMLInputElement {
  const el = container.querySelector(`.${cls}`);
  if (el === null) throw new Error(`missing .${cls}`);
  return el as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  const el = container.querySelector(".settings-form-save");
  if (el === null) throw new Error("missing save button");
  return el as HTMLButtonElement;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("TelegramSettingsForm: read + redacted display", () => {
  it("loads the projection, PREFILLS the non-secret allowlist values, keeps counts, never shows a token (ST-1B)", async () => {
    mockedTelegramFetch.mockResolvedValue({
      available: true,
      value: {
        configured: true,
        allowedChatIds: 3,
        allowedChatIdValues: [123456789, -100, 42],
        defaultAgent: "piren",
        feedbackEnabled: true,
      },
    });
    mockedFetchConversationAgents.mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    await renderTelegram();
    expect(container.textContent).toContain("3"); // bounded count copy stays
    expect(container.textContent).toContain("configured"); // token status only
    // Full non-secret values are prefilled as editable text.
    expect(inputByClass("settings-form-chat-ids").value).toBe("123456789, -100, 42");
    // The stored default agent is selected even when not locally runnable.
    const agentSelect = container.querySelector(".settings-form-default-agent") as HTMLSelectElement;
    expect(agentSelect.tagName).toBe("SELECT");
    expect(agentSelect.value).toBe("piren");
    expect(agentSelect.textContent).toContain("not locally runnable");
    expect(inputByClass("settings-form-feedback").checked).toBe(true);
    // The token field is empty and password-typed; never repopulated.
    const token = inputByClass("settings-form-token");
    expect(token.type).toBe("password");
    expect(token.value).toBe("");
  });

  it("renders a bounded unavailable state (never a secret)", async () => {
    mockedTelegramFetch.mockResolvedValue({ available: false, reason: "Local config is not present." });
    await renderTelegram();
    expect(container.textContent).toContain("Local config is not present.");
    expect(container.querySelector(".settings-form-save")).toBeNull();
  });
});

describe("TelegramSettingsForm: validation + save", () => {
  beforeEach(() => {
    mockedTelegramFetch.mockResolvedValue({
      available: true,
      value: { configured: false, allowedChatIds: 0, allowedChatIdValues: [], defaultAgent: null, feedbackEnabled: null },
    });
    mockedFetchConversationAgents.mockResolvedValue({ agents: [{ name: "kimi", online: true }, { name: "dipu", online: true }, { name: "ghost", online: false }] });
  });

  it("shows a bounded field error for a malformed chat-id list and does not save", async () => {
    const onUnauthorized = await renderTelegram();
    setInput(inputByClass("settings-form-chat-ids"), "not-an-id");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toMatch(/chat id/i);
    expect(mockedTelegramSave).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("saves the typed intent, clears the token on success, and never repopulates it", async () => {
    mockedTelegramSave.mockResolvedValue();
    await renderTelegram();
    const token = inputByClass("settings-form-token");
    setInput(token, "NEWTOKEN");
    setInput(inputByClass("settings-form-chat-ids"), "123, -456");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockedTelegramSave).toHaveBeenCalledWith(
      { botToken: "NEWTOKEN", allowedChatIds: [123, -456] },
      "T",
    );
    // Cleared on successful save.
    expect(token.value).toBe("");
    expect(container.textContent).toContain("Saved");
  });

  it("surfaces 401 through onUnauthorized and a revision conflict as a bounded re-read error", async () => {
    mockedTelegramSave.mockRejectedValueOnce(new UnauthorizedError());
    const onUnauthorized = await renderTelegram();
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(onUnauthorized).toHaveBeenCalled();

    mockedTelegramSave.mockRejectedValueOnce(new SettingsHttpError("conflict", "conflict"));
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.textContent).toMatch(/changed since it was read|re-read/i);
  });
});

describe("TelegramSettingsForm: ST-1B prefill/touch/select semantics", () => {
  const SEEDED = {
    available: true as const,
    value: {
      configured: true,
      allowedChatIds: 2,
      allowedChatIdValues: [111, 222],
      defaultAgent: null,
      feedbackEnabled: null,
    },
  };

  function selectByClass(cls: string): HTMLSelectElement {
    const el = container.querySelector(`.${cls}`);
    if (el === null) throw new Error(`missing .${cls}`);
    return el as HTMLSelectElement;
  }

  function setSelect(select: HTMLSelectElement, value: string): void {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  beforeEach(() => {
    vi.mocked(fetchTelegramSettings).mockResolvedValue(SEEDED);
    mockedFetchConversationAgents.mockResolvedValue({ agents: [{ name: "kimi", online: true }, { name: "ghost", online: false }] });
  });

  it("an UNTOUCHED prefilled list is never resent; an explicitly CLEARED list sends an empty replacement", async () => {
    vi.mocked(saveTelegramSettings).mockResolvedValue();
    await renderTelegram();

    // Untouched: only the token change is sent.
    setInput(inputByClass("settings-form-token"), "NEWTOKEN");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(vi.mocked(saveTelegramSettings)).toHaveBeenLastCalledWith({ botToken: "NEWTOKEN" }, "T");

    // Explicitly clearing the touched list clears it through the write path.
    setInput(inputByClass("settings-form-chat-ids"), "");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    // The token was cleared by the first successful save.
    expect(vi.mocked(saveTelegramSettings)).toHaveBeenLastCalledWith({ allowedChatIds: [] }, "T");
  });

  it("the default agent is a labelled roster select with an explicit No-default choice", async () => {
    // Runnable-only selector: both offered agents are online here.
    mockedFetchConversationAgents.mockResolvedValue({ agents: [{ name: "kimi", online: true }, { name: "ghost", online: true }] });
    vi.mocked(saveTelegramSettings).mockResolvedValue();
    await renderTelegram();

    const select = selectByClass("settings-form-default-agent");
    const options = Array.from(select.options).map((o) => o.value);
    expect(options[0]).toBe("");
    expect(options).toContain("kimi");
    expect(options).toContain("ghost");

    setSelect(select, "kimi");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(vi.mocked(saveTelegramSettings)).toHaveBeenLastCalledWith({ defaultAgent: "kimi" }, "T");
  });

  it("selecting No default agent removes the declaration through the typed write contract", async () => {
    vi.mocked(fetchTelegramSettings).mockResolvedValue({
      available: true,
      value: { ...SEEDED.value, defaultAgent: "kimi" },
    });
    vi.mocked(saveTelegramSettings).mockResolvedValue();
    await renderTelegram();

    const select = selectByClass("settings-form-default-agent");
    expect(select.value).toBe("kimi");
    setSelect(select, "");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(vi.mocked(saveTelegramSettings)).toHaveBeenCalledWith({ defaultAgent: null }, "T");
  });

  it("a stored but non-runnable agent displays a bounded Not-locally-runnable state and is NOT resent untouched", async () => {
    vi.mocked(fetchTelegramSettings).mockResolvedValue({
      available: true,
      value: { ...SEEDED.value, defaultAgent: "ghost" },
    });
    mockedFetchConversationAgents.mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    vi.mocked(saveTelegramSettings).mockResolvedValue();
    await renderTelegram();

    const select = selectByClass("settings-form-default-agent");
    expect(select.value).toBe("ghost");
    expect((select.selectedOptions[0]?.textContent ?? "")).toMatch(/not locally runnable/i);

    // Unrelated edit only: the stale selection is not silently resubmitted.
    setInput(inputByClass("settings-form-chat-ids"), "111, 222, 333");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(vi.mocked(saveTelegramSettings)).toHaveBeenLastCalledWith({ allowedChatIds: [111, 222, 333] }, "T");
  });
});

describe("ST-1B lead correction: runnable-only selectors and roster 401 recovery", () => {
  const OFFLINE_ROSTER = { agents: [{ name: "kimi", online: true }, { name: "ghost", online: false }] };
  const SEEDED = {
    available: true as const,
    value: {
      configured: true,
      allowedChatIds: 1,
      allowedChatIdValues: [42],
      defaultAgent: null,
      feedbackEnabled: null,
    },
  };

  function agentOptions(): string[] {
    const select = container.querySelector(".settings-form-default-agent") as HTMLSelectElement;
    return Array.from(select.options).map((o) => o.value);
  }

  beforeEach(() => {
    mockedFetchConversationAgents.mockResolvedValue(OFFLINE_ROSTER);
    vi.mocked(fetchTelegramSettings).mockResolvedValue(SEEDED);
  });

  it("telegram: an offline vault agent is ABSENT from ordinary options; only a stored offline default shows the bounded state", async () => {
    await renderTelegram();
    const options = agentOptions();
    expect(options).toContain("kimi");
    expect(options).not.toContain("ghost");

    // A stored OFFLINE default keeps its bounded Not-locally-runnable option.
    vi.mocked(fetchTelegramSettings).mockResolvedValue({
      available: true,
      value: { ...SEEDED.value, defaultAgent: "ghost" },
    });
    await renderTelegram();
    expect(agentOptions()).toContain("kimi");
    expect(agentOptions()).toContain("ghost"); // present ONLY as bounded state
    const select = container.querySelector(".settings-form-default-agent") as HTMLSelectElement;
    const ghostOption = select.selectedOptions[0] ?? Array.from(select.options).find((o) => o.value === "ghost")!;
    expect(ghostOption.textContent).toMatch(/not locally runnable/i);
    // The runnable choice is ordinary.
    expect(Array.from(select.options).find((o) => o.value === "kimi")!.textContent).toBe("Kimi");
    expect(ghostOption.textContent).toBe("Ghost - not locally runnable");
  });

  it("discord: an offline vault agent is ABSENT from ordinary options", async () => {
    vi.mocked(fetchDiscordSettings).mockResolvedValue({
      available: true as const,
      value: {
        configured: true,
        allowedGuildIds: 0,
        allowedGuildIdValues: [],
        allowedChannelIds: 0,
        allowedChannelIdValues: [],
        allowedThreadIds: null,
        allowedThreadIdValues: null,
        allowedDmUserIds: null,
        allowedDmUserIdValues: null,
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(DiscordSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();
    const options = agentOptions();
    expect(options).toContain("kimi");
    expect(options).not.toContain("ghost");
    const select = container.querySelector(".settings-form-default-agent") as HTMLSelectElement;
    expect(Array.from(select.options).find((o) => o.value === "kimi")!.textContent).toBe("Kimi");
  });

  it("a roster 401 calls the shell recovery callback (onUnauthorized) for both transports", async () => {
    mockedFetchConversationAgents.mockRejectedValue(new UnauthorizedError());
    const telegramOnUnauthorized = await renderTelegram();
    expect(telegramOnUnauthorized).toHaveBeenCalled();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const discordOnUnauthorized = vi.fn();
    await act(async () => {
      root.render(createElement(DiscordSettingsForm, { token: "T", onUnauthorized: discordOnUnauthorized, onValidated: vi.fn() }));
    });
    await flush();
    expect(discordOnUnauthorized).toHaveBeenCalled();
  });

  it("non-auth roster failures stay bounded (no crash, no policy bypass)", async () => {
    mockedFetchConversationAgents.mockRejectedValue(new Error("network down"));
    await renderTelegram();
    // The select still renders with No-default plus any stored bounded state.
    expect(agentOptions()).toContain("");
    expect(saveButton()).not.toBeNull();
  });
});

describe("DiscordSettingsForm: snowflake validation smoke", () => {
  beforeEach(() => {
    mockedDiscordFetch.mockResolvedValue({
      available: true,
      value: {
        configured: false,
        allowedGuildIds: 0,
        allowedGuildIdValues: [],
        allowedChannelIds: 0,
        allowedChannelIdValues: [],
        allowedThreadIds: null,
        allowedThreadIdValues: null,
        allowedDmUserIds: null,
        allowedDmUserIdValues: null,
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
  });

  it("ST-1B: prefills non-secret snowflake lists; an untouched list is not resent; a cleared list sends an empty replacement", async () => {
    vi.mocked(fetchDiscordSettings).mockResolvedValue({
      available: true as const,
      value: {
        configured: true,
        allowedGuildIds: 2,
        allowedGuildIdValues: ["111111111111111111", "222222222222222222"],
        allowedChannelIds: 1,
        allowedChannelIdValues: ["333333333333333333"],
        allowedThreadIds: null,
        allowedThreadIdValues: null,
        allowedDmUserIds: null,
        allowedDmUserIdValues: null,
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
    mockedFetchConversationAgents.mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    mockedDiscordSave.mockResolvedValue();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(DiscordSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();

    expect(inputByClass("settings-form-guild-ids").value).toBe("111111111111111111, 222222222222222222");
    expect(inputByClass("settings-form-channel-ids").value).toBe("333333333333333333");

    // Untouched lists are not resent.
    setInput(inputByClass("settings-form-token"), "DTOKEN");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockedDiscordSave).toHaveBeenLastCalledWith({ botToken: "DTOKEN" }, "T");

    // Explicitly clearing the touched guild list clears it.
    setInput(inputByClass("settings-form-guild-ids"), "");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    // The token was cleared by the first successful save.
    expect(mockedDiscordSave).toHaveBeenLastCalledWith({ allowedGuildIds: [] }, "T");
  });


  it("validates guild snowflakes structurally before saving", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(DiscordSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();
    setInput(inputByClass("settings-form-guild-ids"), "123"); // too short
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toMatch(/snowflake|15-22 digits|guild/i);
    expect(mockedDiscordSave).not.toHaveBeenCalled();
    // A valid snowflake saves the typed intent with a write-only token.
    mockedDiscordSave.mockResolvedValue();
    setInput(inputByClass("settings-form-guild-ids"), "123456789012345678");
    setInput(inputByClass("settings-form-token"), "DISCORDTOKEN");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(mockedDiscordSave).toHaveBeenCalledWith(
      { botToken: "DISCORDTOKEN", allowedGuildIds: ["123456789012345678"] },
      "T",
    );
    expect(inputByClass("settings-form-token").value).toBe("");
  });
});

describe("SchedulerSettingsForm: closed diff save (W6)", () => {
  const SCHED = {
    available: true as const,
    value: {
      present: true,
      legacyMasterGate: "absent" as const,
      automation: { inboxTasks: false, agentCron: false, scriptCron: false },
      deviceIdConfigured: false,
      pollIntervalSeconds: null,
      staleAfterSeconds: null,
      maxConcurrentAgents: null,
      deviceId: null,
    },
  };

  beforeEach(() => {
    vi.mocked(fetchSchedulerSettings).mockResolvedValue(SCHED);
  });

  it("renders no master-gate checkbox and sends only the fields the steward changed (ST-1A)", async () => {
    vi.mocked(saveSchedulerSettings).mockResolvedValue();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SchedulerSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();

    // The retired master gate is gone from the form entirely.
    expect(container.querySelector(".settings-scheduler-enabled")).toBeNull();
    expect(container.textContent).not.toMatch(/scheduler enabled/i);

    const inbox = inputByClass("settings-scheduler-inbox");
    setChecked(inbox, true);
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(saveSchedulerSettings).toHaveBeenCalledWith({ automation: { inbox_tasks: true } }, "T");
  });

  it("a legacy-GATED projection refuses every save with bounded configure guidance and performs no write", async () => {
    vi.mocked(fetchSchedulerSettings).mockResolvedValue({
      available: true as const,
      value: {
        present: true,
        legacyMasterGate: "gated" as const,
        automation: { inboxTasks: false, agentCron: false, scriptCron: false },
        deviceIdConfigured: false,
        pollIntervalSeconds: null,
        staleAfterSeconds: null,
        maxConcurrentAgents: null,
        deviceId: null,
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SchedulerSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();

    // Bounded guidance names the sole migration writer; never raw config.
    expect(container.textContent).toContain("piren scheduler configure");
    expect(container.textContent).toMatch(/cannot migrate|legacy/i);

    // Every control and the save button are disabled.
    for (const selector of [
      ".settings-scheduler-inbox",
      ".settings-scheduler-agent-cron",
      ".settings-scheduler-script-cron",
      ".settings-scheduler-poll",
      ".settings-scheduler-stale",
      ".settings-scheduler-concurrency",
      ".settings-scheduler-device",
      ".settings-form-save",
    ]) {
      const el = container.querySelector(selector) as HTMLInputElement | HTMLButtonElement;
      expect(el, selector).not.toBeNull();
      expect(el.disabled, selector).toBe(true);
    }

    // Clicking save (even programmatically) performs NO write.
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveSchedulerSettings).not.toHaveBeenCalled();
  });

  it("a legacy-IGNORED projection shows a bounded inert-key notice but keeps normal saving", async () => {
    vi.mocked(fetchSchedulerSettings).mockResolvedValue({
      available: true as const,
      value: {
        present: true,
        legacyMasterGate: "ignored" as const,
        automation: { inboxTasks: false, agentCron: false, scriptCron: false },
        deviceIdConfigured: false,
        pollIntervalSeconds: null,
        staleAfterSeconds: null,
        maxConcurrentAgents: null,
        deviceId: null,
      },
    });
    vi.mocked(saveSchedulerSettings).mockResolvedValue();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SchedulerSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();

    expect(container.textContent).toMatch(/inert|ignored/i);
    expect(container.textContent).toContain("piren scheduler configure");

    const inbox = inputByClass("settings-scheduler-inbox");
    expect(inbox.disabled).toBe(false);
    setChecked(inbox, true);
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveSchedulerSettings).toHaveBeenCalledWith({ automation: { inbox_tasks: true } }, "T");
  });

  it("rejects a non-positive poll interval with a bounded field error", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SchedulerSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();
    setInput(inputByClass("settings-scheduler-poll"), "0");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toMatch(/positive integer/i);
    expect(saveSchedulerSettings).not.toHaveBeenCalled();
  });
});

describe("AgentPreferencesForm: roster + fallback confirmation (W6)", () => {
  const PREF = {
    available: true as const,
    value: {
      model: { id: "anthropic/claude-sonnet-4-6", thinking: "high" },
      modelFallback: { declared: true, autoSwitch: true, modelCount: 1, models: ["openrouter/kimi-k3"] },
      contextInjection: { mode: "session_start_only" },
      selfImprovement: { autoNudge: true, reviewLoopEnabled: true, reviewLoop: { intervalTurns: 10, recentMessages: 20, timeoutMs: 120000 } },
    },
  };

  function renderPrefs(): void {
    // A previous render inside the same test must be unmounted before the
    // file-level query helpers can stay unambiguous.
    if (root !== undefined) {
      act(() => root.unmount());
      container?.remove();
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(AgentPreferencesForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
  }

  async function chooseAgent(name: string): Promise<void> {
    const radio = container.querySelector<HTMLInputElement>(`.settings-agent-card input[value="${name}"]`);
    if (radio === null) throw new Error(`agent card missing: ${name}`);
    await act(async () => radio.click());
    await flush();
  }

  beforeEach(() => {
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "kimi", online: true }, { name: "ghost", online: false }] });
    vi.mocked(fetchAgentPreferences).mockResolvedValue(PREF);
  });

  it("ST-3 roster: runnable-only radio cards load the projection; offline agents excluded; empty roster is honest", async () => {
    renderPrefs();
    await flush();
    // Radio group with ONLY the runnable agent.
    const group = container.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    const values = Array.from(container.querySelectorAll<HTMLInputElement>('.settings-agent-cards input[type="radio"]')).map((r) => r.value);
    expect(values).toEqual(["kimi"]);
    // Selecting a card loads the projection.
    await chooseAgent("kimi");
    expect(fetchAgentPreferences).toHaveBeenCalledWith("kimi", "T");

    // No runnable agents: honest non-action state with CLI guidance.
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "ghost", online: false }] });
    renderPrefs();
    await flush();
    expect(container.textContent).toMatch(/no locally runnable agents/i);
    expect(container.textContent).toMatch(/piren|config/i);
  });

  it("ST-3 fallback: ordered editor rows reorder and save the whole visible order; enabled auto-switch needs explicit modal confirm", async () => {
    vi.mocked(saveAgentModelFallback).mockResolvedValue();
    renderPrefs();
    await flush();
    await chooseAgent("kimi");

    // The stored model appears as an ordered row; add a second one.
    expect(document.querySelectorAll(".settings-agent-fallback-row").length).toBe(1);
    const add = inputByClass("settings-agent-fallback-add");
    setInput(add, "openai/gpt-4o");
    act(() => container.querySelector(".settings-agent-fallback-add-button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    let rows = Array.from(container.querySelectorAll(".settings-agent-fallback-model")).map((n) => n.textContent);
    expect(rows).toEqual(["openrouter/kimi-k3", "openai/gpt-4o"]);

    // Move the second row up: visible order becomes saved order.
    act(() => container.querySelector(".settings-agent-fallback-down")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    rows = Array.from(container.querySelectorAll(".settings-agent-fallback-model")).map((n) => n.textContent);
    expect(rows).toEqual(["openai/gpt-4o", "openrouter/kimi-k3"]);

    // Save with auto-switch still enabled: modal opens, NOTHING writes yet.
    const fallbackSave = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save fallback") as HTMLButtonElement;
    fallbackSave.focus();
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(saveAgentModelFallback).not.toHaveBeenCalled();

    // Escape cancels: no write, focus returns to the save button.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(saveAgentModelFallback).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(fallbackSave);

    // Confirm executes the ORIGINAL pending save with confirmAutoSwitch:true.
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    act(() => container.querySelector(".settings-agent-confirm-save")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveAgentModelFallback).toHaveBeenCalledWith(
      "kimi",
      { models: ["openai/gpt-4o", "openrouter/kimi-k3"] },
      true,
      "T",
    );
  });

  it("ST-3 fallback: disabled auto-switch saves directly without any dialog; remove control updates the list", async () => {
    vi.mocked(saveAgentModelFallback).mockResolvedValue();
    renderPrefs();
    await flush();
    await chooseAgent("kimi");
    setChecked(inputByClass("settings-agent-autoswitch"), false);

    // Remove the only row -> validation error, no write.
    act(() => container.querySelector(".settings-agent-fallback-remove")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const fallbackSave = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save fallback") as HTMLButtonElement;
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.textContent).toMatch(/provider\/modelId/i);
    expect(saveAgentModelFallback).not.toHaveBeenCalled();

    // Re-add and save: no dialog for a disabled declaration.
    setInput(inputByClass("settings-agent-fallback-add"), "openai/gpt-4o");
    act(() => container.querySelector(".settings-agent-fallback-add-button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(saveAgentModelFallback).toHaveBeenCalledWith("kimi", { models: ["openai/gpt-4o"], autoSwitch: false }, false, "T");
  });

  it("ST-3 correction: an INVALID current declaration never opens confirmation; bounded error, no pending save", async () => {
    vi.mocked(saveAgentModelFallback).mockResolvedValue();
    renderPrefs();
    await flush();
    await chooseAgent("kimi");
    // Empty the ordered list entirely while auto-switch stays enabled.
    act(() => container.querySelector(".settings-agent-fallback-remove")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const fallbackSave = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save fallback") as HTMLButtonElement;
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toMatch(/provider\/modelId/i);
    expect(saveAgentModelFallback).not.toHaveBeenCalled();

    // An invalid entry is also rejected before any dialog.
    setInput(inputByClass("settings-agent-fallback-add"), "not-a-model");
    act(() => container.querySelector(".settings-agent-fallback-add-button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(saveAgentModelFallback).not.toHaveBeenCalled();
  });

  it("ST-3 correction: the confirmation dialog TRAPS focus (Tab/Shift+Tab cycle inside) and Escape works from within", async () => {
    renderPrefs();
    await flush();
    await chooseAgent("kimi");
    const fallbackSave = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save fallback") as HTMLButtonElement;
    fallbackSave.focus();
    await act(async () => fallbackSave.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    // Focus moved inside on open.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab on the LAST control wraps to the first; Shift+Tab on the first wraps to the last.
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    expect(controls.length).toBeGreaterThanOrEqual(3);
    controls[controls.length - 1]!.focus();
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
    controls[0]!.focus();
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);

    // Escape works wherever focus is inside; focus returns to the Save button.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(saveAgentModelFallback).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(fallbackSave);
  });

  it("SR-1: roster cards show a decorative uppercase initial beside the name while retaining genuine radio semantics", async () => {
    vi.mocked(fetchConversationAgents).mockResolvedValue({ agents: [{ name: "kimi", online: true }] });
    renderPrefs();
    await flush();
    const card = container.querySelector(".settings-agent-card");
    expect(card).not.toBeNull();
    // The genuine radio stays in the accessible tree with its group.
    const radio = card!.querySelector('input[type="radio"]');
    expect(radio).not.toBeNull();
    expect((radio as HTMLInputElement).value).toBe("kimi");
    // The initial is decorative and derived from the agent name...
    const initial = card!.querySelector(".settings-agent-initial");
    expect(initial).not.toBeNull();
    expect(initial!.getAttribute("aria-hidden")).toBe("true");
    expect(initial!.textContent).toBe("K");
    // ...and the name itself remains available text.
    expect(card!.querySelector(".settings-agent-card-name")?.textContent).toBe("Kimi");
  });

  it("ST-3 context: the Default option label names the core default exactly", async () => {
    renderPrefs();
    await flush();
    await chooseAgent("kimi");
    const modeSelect = container.querySelector(".settings-agent-context-mode") as HTMLSelectElement;
    expect(modeSelect.options[0]?.textContent).toBe("Default (session_start_only)");
  });

  it("SR-1: review-loop fields visibly show effective defaults when absent and never materialize them on an unrelated save", async () => {
    vi.mocked(fetchAgentPreferences).mockResolvedValue({
      available: true as const,
      value: {
        model: { id: null, thinking: null },
        modelFallback: { declared: false, autoSwitch: null, modelCount: 0, models: [] },
        contextInjection: { mode: null },
        selfImprovement: {
          autoNudge: false,
          reviewLoopEnabled: false,
          reviewLoop: { intervalTurns: null, recentMessages: null, timeoutMs: null },
        },
      },
    });
    renderPrefs();
    await flush();
    await chooseAgent("kimi");

    // Effective defaults are VISIBLE for absent declarations.
    expect((inputByClass("settings-agent-review-interval") as HTMLInputElement).placeholder).toContain("10");
    expect((inputByClass("settings-agent-review-recent") as HTMLInputElement).placeholder).toContain("20");
    expect((inputByClass("settings-agent-review-timeout") as HTMLInputElement).placeholder).toContain("120000");

    // Saving an unrelated toggle never writes the absent numeric declarations.
    vi.mocked(saveAgentSelfImprovement).mockResolvedValue();
    setChecked(inputByClass("settings-agent-autonudge"), true);
    await act(async () => saveSelfImprovementButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveAgentSelfImprovement).toHaveBeenCalledWith("kimi", { autoNudge: true }, "T");

    // An explicitly touched field persists its chosen value — including the
    // exact effective default.
    setInput(inputByClass("settings-agent-review-interval"), "10");
    await act(async () => saveSelfImprovementButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveAgentSelfImprovement).toHaveBeenLastCalledWith(
      "kimi",
      { autoNudge: true, reviewLoopIntervalTurns: 10 },
      "T",
    );
  });
});

describe("SR-1: truthful service status badges", () => {
  function renderForm(component: typeof TelegramSettingsForm): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return act(async () => {
      root.render(createElement(component, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("telegram ready: green CONFIGURED when configured, muted NOT CONFIGURED otherwise; no badge while loading or unavailable", async () => {
    mockedTelegramFetch.mockResolvedValue({
      available: true as const,
      value: {
        configured: true,
        allowedChatIds: 2,
        allowedChatIdValues: [1, 2],
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
    await renderForm(TelegramSettingsForm);
    let badge = container.querySelector(".settings-family-header .agent-status");
    expect(badge?.className).toContain("status-ok");
    expect(badge?.textContent).toMatch(/^configured$/i);

    mockedTelegramFetch.mockResolvedValue({
      available: true as const,
      value: {
        configured: false,
        allowedChatIds: 0,
        allowedChatIdValues: [],
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
    await renderForm(TelegramSettingsForm);
    badge = container.querySelector(".settings-family-header .agent-status");
    expect(badge?.className).toContain("status-muted");
    expect(badge?.textContent).toMatch(/not configured/i);

    // Loading truthfully shows NO badge (never a fabricated status).
    vi.mocked(fetchTelegramSettings).mockReturnValue(new Promise(() => {}));
    await renderForm(TelegramSettingsForm);
    expect(container.querySelector(".settings-family-header .agent-status")).toBeNull();

    // Unavailable likewise shows no badge.
    mockedTelegramFetch.mockResolvedValue({ available: false as const, reason: "Local config is not present." });
    await renderForm(TelegramSettingsForm);
    expect(container.querySelector(".settings-family-header .agent-status")).toBeNull();
  });

  it("discord ready carries the same truthful badge vocabulary", async () => {
    mockedDiscordFetch.mockResolvedValue({
      available: true as const,
      value: {
        configured: false,
        allowedGuildIds: 0,
        allowedGuildIdValues: [],
        allowedChannelIds: 0,
        allowedChannelIdValues: [],
        allowedThreadIds: null,
        allowedThreadIdValues: null,
        allowedDmUserIds: null,
        allowedDmUserIdValues: null,
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
    await renderForm(DiscordSettingsForm);
    const badge = container.querySelector(".settings-family-header .agent-status");
    expect(badge?.className).toContain("status-muted");
    expect(badge?.textContent).toMatch(/not configured/i);
  });

  it("scheduler badge reflects only whether a scheduler block is actually declared (present), in both directions", async () => {
    vi.mocked(fetchSchedulerSettings).mockResolvedValue({
      available: true as const,
      value: {
        present: false,
        legacyMasterGate: "absent" as const,
        automation: { inboxTasks: false, agentCron: false, scriptCron: false },
        deviceIdConfigured: false,
        pollIntervalSeconds: null,
        staleAfterSeconds: null,
        maxConcurrentAgents: null,
        deviceId: null,
      },
    });
    await renderForm(SchedulerSettingsForm);
    let badge = container.querySelector(".settings-family-header .agent-status");
    expect(badge?.className).toContain("status-muted");
    expect(badge?.textContent).toMatch(/not configured/i);

    vi.mocked(fetchSchedulerSettings).mockResolvedValue({
      available: true as const,
      value: {
        present: true,
        legacyMasterGate: "absent" as const,
        automation: { inboxTasks: false, agentCron: false, scriptCron: false },
        deviceIdConfigured: false,
        pollIntervalSeconds: null,
        staleAfterSeconds: null,
        maxConcurrentAgents: null,
        deviceId: null,
      },
    });
    await renderForm(SchedulerSettingsForm);
    badge = container.querySelector(".settings-family-header .agent-status");
    expect(badge?.className).toContain("status-ok");
    expect(badge?.textContent).toMatch(/^configured$/i);
  });
});

describe("SR-1: display-only scheduler effective defaults", () => {
  const SCHED_NULLS = {
    available: true as const,
    value: {
      present: true,
      legacyMasterGate: "absent" as const,
      automation: { inboxTasks: false, agentCron: false, scriptCron: false },
      deviceIdConfigured: false,
      pollIntervalSeconds: null,
      staleAfterSeconds: null,
      maxConcurrentAgents: null,
      deviceId: null,
    },
  };

  async function renderScheduler(): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SchedulerSettingsForm, { token: "T", onUnauthorized: vi.fn(), onValidated: vi.fn() }));
    });
    await flush();
  }

  beforeEach(() => {
    vi.mocked(fetchSchedulerSettings).mockResolvedValue(SCHED_NULLS);
    vi.mocked(saveSchedulerSettings).mockResolvedValue();
  });

  it("absent declarations visibly show the effective defaults 30/300/1 without holding them as values", async () => {
    await renderScheduler();
    const poll = inputByClass("settings-scheduler-poll") as HTMLInputElement;
    const stale = inputByClass("settings-scheduler-stale") as HTMLInputElement;
    const concurrency = inputByClass("settings-scheduler-concurrency") as HTMLInputElement;
    expect(poll.value).toBe("");
    expect(stale.value).toBe("");
    expect(concurrency.value).toBe("");
    expect(poll.placeholder).toContain("30");
    expect(stale.placeholder).toContain("300");
    expect(concurrency.placeholder).toContain("1");
  });

  it("loading then saving an unrelated field never materializes the absent numeric declarations", async () => {
    await renderScheduler();
    setChecked(inputByClass("settings-scheduler-inbox"), true);
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveSchedulerSettings).toHaveBeenCalledWith({ automation: { inbox_tasks: true } }, "T");
  });

  it("an explicitly touched field saves its chosen value — including the exact effective default", async () => {
    await renderScheduler();
    setInput(inputByClass("settings-scheduler-poll"), "30");
    await act(async () => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(saveSchedulerSettings).toHaveBeenCalledWith(
      { pollIntervalSeconds: 30 },
      "T",
    );
  });
});

function setChecked(input: HTMLInputElement, checked: boolean): void {
  act(() => {
    // React's checkbox onChange is driven by the native click toggle.
    if (input.checked !== checked) input.click();
  });
}

function saveSelfImprovementButton(): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save self-improvement");
  if (el === undefined) throw new Error("missing Save self-improvement button");
  return el as HTMLButtonElement;
}
