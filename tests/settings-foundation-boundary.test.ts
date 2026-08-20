import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * W4 + W5 boundary proof (0.2.0 amendment §5; ADR-0046): the Settings
 * foundation is a server-side core; W5 exposes ONLY the narrow typed
 * transport routes over it. These pins prove the gateway gained only the
 * four Telegram/Discord read/write routes (no generic /api/settings), the
 * web transport gained only the matching narrow helpers, the Settings UI
 * uses the typed forms (never a direct foundation call or raw editor), and
 * nothing imports the foundation from a CLI/config wizard path.
 */

const repoRoot = process.cwd();

describe("W6 boundary: narrow typed Settings surface only", () => {
  it("the gateway exposes ONLY the typed transport/scheduler/agent Settings routes (no generic /api/settings)", async () => {
    const gateway = await readFile(join(repoRoot, "src", "gateway-http.ts"), "utf8");
    expect(gateway).toContain("/api/settings/telegram");
    expect(gateway).toContain("/api/settings/discord");
    expect(gateway).toContain("/api/settings/scheduler");
    expect(gateway).toContain("/api/settings/agents/");
    // No generic reader/patcher/editor.
    expect(gateway).not.toMatch(/\/api\/settings["`)]/);
    expect(gateway).not.toContain("/api/settings/patch");
    expect(gateway).not.toContain("/api/settings/raw");
  });

  it("the CLI dispatcher does not wire the foundation (configure stays the S3 wizard)", async () => {
    const cli = await readFile(join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toContain("settings-foundation");
    expect(cli).not.toContain("applyLocalSettingsIntent");
    expect(cli).not.toContain("applyAgentSettingsIntent");
  });

  it("the web typed transport has ONLY the typed transport/scheduler/agent Settings families (no generic reader/patcher)", async () => {
    const api = await readFile(join(repoRoot, "web", "src", "api.ts"), "utf8");
    expect(api).toContain("/api/settings/telegram");
    expect(api).toContain("/api/settings/discord");
    expect(api).toContain("/api/settings/scheduler");
    expect(api).toContain("/api/settings/agents/");
    expect(api).not.toMatch(/\/api\/settings["`]/);
    expect(api).not.toContain("/api/settings/patch");
    expect(api).not.toContain("/api/settings/raw");
  });

  it("the Settings shell uses the typed forms and never calls the foundation or edits raw config", async () => {
    const view = await readFile(join(repoRoot, "web", "src", "SettingsView.tsx"), "utf8");
    expect(view).toContain("TelegramSettingsForm");
    expect(view).toContain("DiscordSettingsForm");
    expect(view).toContain("SchedulerSettingsForm");
    expect(view).toContain("AgentPreferencesForm");
    expect(view).not.toContain("fetch(");
    expect(view).not.toContain("applyLocalSettingsIntent");
    expect(view).not.toContain("applyAgentSettingsIntent");
    expect(view).not.toContain("dangerouslySetInnerHTML");
  });

  it("the foundation module itself performs no network, platform, service, or scheduler action", async () => {
    const foundation = await readFile(join(repoRoot, "src", "settings-foundation.ts"), "utf8");
    for (const marker of ["fetch(", "http.", "https.", "systemctl", "service install", "schedulerOnce", "runSchedulerLoop", "exec(", "spawn("]) {
      expect(foundation, `foundation must not contain ${marker}`).not.toContain(marker);
    }
  });
});
