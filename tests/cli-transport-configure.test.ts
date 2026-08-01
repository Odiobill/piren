import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch tests for `piren telegram configure` and
// `piren discord configure` (ADR-0040). The pure core is covered in
// tests/transport-configure.test.ts; this file exercises the real CLI binary
// so a regression in the cli.ts subcommand dispatch (or bare-command daemon
// behavior) cannot ship green. Answers are piped through stdin; no live
// credentials, daemons, services, or network are involved.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runPiren(
  args: string[],
  env: Record<string, string>,
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  // Strip Piren env vars from the ambient shell so the spawned CLI observes
  // only the isolated HOME (e.g. a real PIREN_AGENT in the developer shell
  // must not leak into the test).
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("PIREN_")) delete cleanEnv[key];
  }
  const result = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: "utf8",
    env: { ...cleanEnv, ...env },
    ...(input !== undefined ? { input } : {}),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "piren-transport-configure-cli-"));
  const vault = join(home, "vault");
  await mkdir(join(vault, "team", "piren"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  await writeFile(join(vault, "steward-directives.md"), "# directives");
  await writeFile(join(vault, "team", "piren", "SOUL.md"), "# Piren\n");
  await writeFile(join(vault, "team", "piren", "MEMORY.md"), "# Memory\n");
  await mkdir(join(home, ".config", "piren"), { recursive: true });
  await writeFile(
    join(home, ".config", "piren", "config.yml"),
    ["vault_root: " + vault, "", "allowed_agents:", "  - piren", ""].join("\n"),
  );
  return home;
}

const configPath = (home: string) => join(home, ".config", "piren", "config.yml");

describe("piren telegram configure (CLI dispatch)", () => {
  it("guides a fresh configuration with a redacted preview and confirmation", async () => {
    const home = await seedHome();
    const answers = [
      "123456:e2e-telegram-token", // secret: bot token
      "123456789, -1001234567890", // chat ids
      "", // feedback enabled (default yes)
      "", // receipt emoji (default)
      "", // completion emoji (default)
      "", // typing (default yes)
      "1", // default agent: first (only) runnable agent
      "y", // confirm write
      "",
    ].join("\n");
    const result = runPiren(["telegram", "configure"], { HOME: home }, answers);
    expect(result.status).toBe(0);
    // The token never appears in stdout; the preview is redacted.
    expect(result.stdout).not.toContain("e2e-telegram-token");
    expect(result.stdout).toContain("<redacted:");
    expect(result.stdout).toContain("Validation: [ok]");
    const written = await readFile(configPath(home), "utf8");
    expect(written).toContain("bot_token: 123456:e2e-telegram-token");
    expect(written).toContain("- 123456789");
    expect(written).toContain("- -1001234567890");
    expect(written).toContain("default_agent: piren");
    // Unrelated top-level keys survive.
    expect(written).toContain("vault_root: " + join(home, "vault"));
    expect(written).toContain("allowed_agents:");
  });

  it("leaves the config byte-identical when the write is declined", async () => {
    const home = await seedHome();
    const before = await readFile(configPath(home), "utf8");
    const answers = ["tok", "42", "", "", "", "", "1", "n", ""].join("\n");
    const result = runPiren(["telegram", "configure"], { HOME: home }, answers);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No changes were written");
    const after = await readFile(configPath(home), "utf8");
    expect(after).toBe(before);
  });

  it("bare `piren telegram` still takes the daemon path", async () => {
    const home = await seedHome();
    const result = runPiren(["telegram"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing telegram.bot_token");
  });

  it("rejects an unknown telegram subcommand with usage", async () => {
    const home = await seedHome();
    const result = runPiren(["telegram", "bogus"], { HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: piren telegram \[configure\]/i);
  });
});

describe("piren discord configure (CLI dispatch)", () => {
  it("guides a fresh configuration and preserves unprompted fields", async () => {
    const home = await seedHome();
    // Pre-seed a discord block with unprompted fields plus an unrelated block.
    const seeded = [
      "vault_root: " + join(home, "vault"),
      "",
      "allowed_agents:",
      "  - piren",
      "",
      "discord:",
      '  application_id: "999888777111222333"',
      '  install_url: "https://discord.com/oauth2/authorize?client_id=999888777111222333"',
      "",
      "scheduler:",
      "  poll_interval_seconds: 45",
      "",
    ].join("\n");
    await writeFile(configPath(home), seeded);
    const answers = [
      "e2e-discord-token", // secret: bot token
      "111111111111111111", // guild ids
      "222222222222222222", // channel ids
      "", // thread ids (none)
      "444444444444444444", // optional one-to-one DM user ids
      "", // feedback enabled (default yes)
      "", // receipt emoji (default)
      "", // completion emoji (default)
      "", // typing (default yes)
      "1", // default agent
      "y", // confirm write
      "",
    ].join("\n");
    const result = runPiren(["discord", "configure"], { HOME: home }, answers);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("e2e-discord-token");
    expect(result.stdout).toContain("<redacted:");
    const written = await readFile(configPath(home), "utf8");
    expect(written).toContain('"111111111111111111"');
    expect(written).toContain('"222222222222222222"');
    expect(written).not.toContain("allowed_thread_ids");
    expect(written).toContain("allowed_dm_user_ids:");
    expect(written).toContain('"444444444444444444"');
    // Unprompted discord fields and unrelated blocks survive.
    expect(written).toContain('application_id: "999888777111222333"');
    expect(written).toContain("install_url: https://discord.com/oauth2/authorize?client_id=999888777111222333");
    expect(written).toContain("poll_interval_seconds: 45");
    expect(written).toContain("default_agent: piren");
    expect(written).toContain("reaction_on_complete: ✅");
  });

  it("bare `piren discord` still takes the daemon path", async () => {
    const home = await seedHome();
    const result = runPiren(["discord"], { HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing discord.bot_token");
  });

  it("rejects an unknown discord subcommand with usage", async () => {
    const home = await seedHome();
    const result = runPiren(["discord", "bogus"], { HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: piren discord \[configure\]/i);
  });
});

describe("transport configure help", () => {
  it("documents the configure subcommand in command help", async () => {
    const home = await seedHome();
    const telegram = runPiren(["telegram", "--help"], { HOME: home });
    expect(telegram.status).toBe(0);
    expect(telegram.stdout).toContain("configure");
    const discord = runPiren(["discord", "--help"], { HOME: home });
    expect(discord.status).toBe(0);
    expect(discord.stdout).toContain("configure");
  });
});
