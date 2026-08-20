import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * W4 boundary proof (0.2.0 amendment §5; ADR-0046): the Settings foundation
 * is a server-side core with NO browser-facing surface. These pins prove the
 * gateway gained no Settings route, the web transport gained no Settings
 * call, the Settings UI gained no fetch/form, and nothing imports the
 * foundation from any HTTP/CLI/UI dispatch path. W5/W6 will add the actual
 * per-workflow routes and their bind-independent auth proof.
 */

const repoRoot = process.cwd();

describe("W4 boundary: no browser-facing Settings surface", () => {
  it("the gateway HTTP server has no Settings route or settings-foundation import", async () => {
    const gateway = await readFile(join(repoRoot, "src", "gateway-http.ts"), "utf8");
    expect(gateway).not.toMatch(/\/api\/settings/i);
    expect(gateway).not.toContain("settings-foundation");
    expect(gateway).not.toContain("applyLocalSettingsIntent");
    expect(gateway).not.toContain("applyAgentSettingsIntent");
  });

  it("the CLI dispatcher does not wire the foundation (configure stays the S3 wizard)", async () => {
    const cli = await readFile(join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toContain("settings-foundation");
    expect(cli).not.toContain("applyLocalSettingsIntent");
    expect(cli).not.toContain("applyAgentSettingsIntent");
  });

  it("the web typed transport has no Settings endpoint family", async () => {
    const api = await readFile(join(repoRoot, "web", "src", "api.ts"), "utf8");
    expect(api).not.toMatch(/settings/i);
  });

  it("the Settings shell stays a static read-only inventory (no fetch/form mutation)", async () => {
    const view = await readFile(join(repoRoot, "web", "src", "SettingsView.tsx"), "utf8");
    expect(view).not.toContain("fetch(");
    expect(view).not.toContain("<form");
    expect(view).not.toContain("<input");
    expect(view).not.toContain("<button");
    expect(view).not.toContain("applyLocalSettingsIntent");
    expect(view).not.toContain("applyAgentSettingsIntent");
  });

  it("the foundation module itself performs no network, platform, service, or scheduler action", async () => {
    const foundation = await readFile(join(repoRoot, "src", "settings-foundation.ts"), "utf8");
    for (const marker of ["fetch(", "http.", "https.", "systemctl", "service install", "schedulerOnce", "runSchedulerLoop", "exec(", "spawn("]) {
      expect(foundation, `foundation must not contain ${marker}`).not.toContain(marker);
    }
  });
});
