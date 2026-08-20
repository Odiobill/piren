// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TelegramSettingsForm } from "../web/src/TelegramSettingsForm.js";
import { DiscordSettingsForm } from "../web/src/DiscordSettingsForm.js";
import {
  fetchTelegramSettings,
  fetchDiscordSettings,
  saveTelegramSettings,
  saveDiscordSettings,
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
  };
});

const mockedTelegramFetch = vi.mocked(fetchTelegramSettings);
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
  it("loads the redacted projection, shows the count (never the raw ids/token), and populates default agent + feedback", async () => {
    mockedTelegramFetch.mockResolvedValue({
      available: true,
      value: { configured: true, allowedChatIds: 3, defaultAgent: "piren", feedbackEnabled: true },
    });
    await renderTelegram();
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("123456789"); // never raw ids
    expect(container.textContent).toContain("configured"); // token status only
    expect(inputByClass("settings-form-default-agent").value).toBe("piren");
    expect(inputByClass("settings-form-feedback").checked).toBe(true);
    // The token field is empty and password-typed.
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
      value: { configured: false, allowedChatIds: 0, defaultAgent: null, feedbackEnabled: null },
    });
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

describe("DiscordSettingsForm: snowflake validation smoke", () => {
  beforeEach(() => {
    mockedDiscordFetch.mockResolvedValue({
      available: true,
      value: {
        configured: false,
        allowedGuildIds: 0,
        allowedChannelIds: 0,
        allowedThreadIds: null,
        allowedDmUserIds: null,
        defaultAgent: null,
        feedbackEnabled: null,
      },
    });
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
