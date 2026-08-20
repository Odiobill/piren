import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_MODULES } from "../web/src/registry.js";

/**
 * W3 (0.2.0 amendment §5; ADR-0046) — static contract for the full-page
 * Settings shell: the W3 files carry NO fetch/API/storage/dynamic-loading/
 * secret/service/mutation surface; the registry declares zero consumption
 * for settings; the shell wiring preserves the persistent Conversation
 * surface and the hidden-toggle panel convention.
 */

const repoRoot = process.cwd();
const webSrc = join(repoRoot, "web", "src");
const W3_FILES = ["settings-inventory.ts"];

const FORBIDDEN_SURFACE = [
  "fetch(",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "WebSocket",
  "new EventSource",
  "eval(",
  "new Function",
  "import(",
  "/api/",
  // Secret-HANDLING code markers (descriptive write-only/no-readback
  // wording is required by the task and stays permitted).
  "bot_token",
  "api_key",
  "apiKey",
  "auth.json",
  "process.env",
  "<input",
  "<textarea",
  "<select",
  "<form",
  "<button",
  "onSubmit",
  "onSave",
];

describe("W3 Settings files: forbidden surface (static)", () => {
  it("the W3 files never touch transport, storage, dynamic loading, secrets, or interactive controls", async () => {
    for (const name of W3_FILES) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const marker of FORBIDDEN_SURFACE) {
        expect(content, `${name} must not contain ${marker}`).not.toContain(marker);
      }
    }
  });

  it("the W3 files perform no service, platform, CLI, scheduler, or vault action", async () => {
    for (const name of W3_FILES) {
      const content = await readFile(join(webSrc, name), "utf8");
      for (const marker of ["systemctl", "service install", "service start", "crontab", "executeScriptCronJob", "piren service", "vault_write", "writeConfig"]) {
        expect(content, `${name} must not contain ${marker}`).not.toContain(marker);
      }
    }
  });
});

describe("W3 registry + shell wiring (static)", () => {
  it("the settings module declares only the narrow transport settings family (W5)", () => {
    const settings = WORKBENCH_MODULES.find((m) => m.id === "settings");
    expect(settings?.consumes).toEqual(["settings-transports", "settings-scheduler", "settings-agents"]);
    expect(settings?.emits).toEqual([]);
    expect(settings?.placement).toBe("page");
  });

  it("the registry stays a compile-time const with no dynamic loading", async () => {
    const registry = await readFile(join(webSrc, "registry.ts"), "utf8");
    expect(registry).not.toContain("import(");
    expect(registry).not.toContain("eval(");
    expect(registry).not.toContain("new Function");
  });

  it("AppShell wires the settings page as a hidden-toggled workspace panel and keeps ConversationNavigator mounted", async () => {
    const shell = await readFile(join(webSrc, "AppShell.tsx"), "utf8");
    expect(shell).toContain("SettingsView");
    expect(shell).toContain('nav.page !== "settings"');
    expect(shell).toContain("hidden");
    // The persistent Conversation surface rule is unchanged.
    expect(shell).toContain("ConversationNavigator");
    expect(shell).toContain('nav.page !== "conversations"');
  });

  it("the sidebar exposes Settings as a typed nav page item", async () => {
    const sidebar = await readFile(join(webSrc, "Sidebar.tsx"), "utf8");
    expect(sidebar).toContain('"settings"');
    expect(sidebar).toContain("aria-current");
  });
});
