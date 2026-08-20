import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_MODULES } from "../web/src/registry.js";

/**
 * W5 (0.2.0 amendment §5/§5.1; ADR-0046): static contract for the typed
 * transport Settings surface. No generic /api/settings reader/patcher/
 * editor, no raw YAML/JSON, no storage, no token readback/fingerprint, no
 * platform contact, no service action, no live-session controls. Only the
 * narrow telegram/discord transport routes and matching typed forms exist.
 */

const repoRoot = process.cwd();
const webSrc = join(repoRoot, "web", "src");
const W5_WEB_FILES = ["settings-transport.ts", "TelegramSettingsForm.tsx", "DiscordSettingsForm.tsx", "SettingsView.tsx"];
const FORBIDDEN = ["localStorage", "sessionStorage", "indexedDB", "eval(", "new Function", "import(", "dangerouslySetInnerHTML"];

describe("Settings module consumes only the transport settings family (W5)", () => {
  it("the settings module declares the transport settings family and nothing broader", () => {
    const settings = WORKBENCH_MODULES.find((m) => m.id === "settings");
    expect(settings?.placement).toBe("page");
    expect(settings?.consumes).toEqual(["settings-transports"]);
  });
});

describe("W5 web files forbidden surface", () => {
  it("no storage, eval, dynamic import, or raw HTML in the W5 files", async () => {
    const files = await readdir(webSrc);
    for (const name of W5_WEB_FILES) {
      expect(files).toContain(name);
      const content = await readFile(join(webSrc, name), "utf8");
      for (const forbidden of FORBIDDEN) {
        expect(content, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
      // No raw platform contact / service invocation / provider or gateway
      // token handling inside the UI surface.
      expect(content, `${name} must not reference a platform endpoint`).not.toMatch(/api\.telegram\.org|discord\.com\/api/);
      expect(content, `${name} must not invoke a service`).not.toMatch(/service install|service start|service stop/);
      expect(content, `${name} must not expose provider credentials`).not.toMatch(/auth\.json|~\/\.pi\/agent/);
    }
  });

  it("the token input is password/write-only and never repopulated from a read", async () => {
    const telegram = await readFile(join(webSrc, "TelegramSettingsForm.tsx"), "utf8");
    const discord = await readFile(join(webSrc, "DiscordSettingsForm.tsx"), "utf8");
    for (const [name, content] of [["TelegramSettingsForm.tsx", telegram], ["DiscordSettingsForm.tsx", discord]] as const) {
      expect(content, name).toContain('type="password"');
      // The token field starts empty and clears on successful save.
      expect(content, name).toMatch(/botToken.*""/);
      expect(content, name).toMatch(/setBotToken\(""\)/);
    }
  });

  it("the shared API transport adds ONLY the four narrow transport settings routes", async () => {
    const api = await readFile(join(webSrc, "api.ts"), "utf8");
    expect(api).toContain('"/api/settings/telegram"');
    expect(api).toContain('"/api/settings/discord"');
    // No generic /api/settings reader/patcher.
    expect(api).not.toMatch(/"\/api\/settings["`]/);
    expect(api).not.toContain("/api/settings/patch");
    expect(api).not.toContain("/api/settings/raw");
  });
});
