import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

// TB5 CLI dispatch test: `piren ask` resolves the selected agent's
// `model.fallback` policy at the CLI boundary and emits the bounded stdout
// advisory + fallback reply — against a temp HOME/vault and a fake `pi` shim
// on PATH, never reading Davide's real config or needing live Pi auth.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");
const fakePiScript = join(repoRoot, "tests", "fixtures", "fake-pi-rpc.cjs");

function runPirenAsk(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "ask", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren ask CLI dispatch (TB5 model fallback)", () => {
  let home: string;
  let vault: string;
  let shimDir: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-ask-cli-home-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "dipu", "inbox"), { recursive: true });
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives\n");
    await writeFile(join(vault, "team", "dipu", "SOUL.md"), "# Dipu\n");
    // Agent-local config with a model.fallback declaration (the policy TB5
    // resolves at the CLI boundary).
    await writeFile(
      join(vault, "team", "dipu", "config.yml"),
      [
        "model:",
        "  id: kimi-coding/k3",
        "  fallback:",
        "    auto_switch: true",
        "    models:",
        "      - openai/gpt-4.1",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - dipu", ""].join("\n"),
    );

    // A `pi` shim on PATH that runs the fake RPC responder (ignores CLI args,
    // speaks the strict LF JSONL protocol the ask client expects).
    shimDir = await mkdtemp(join(tmpdir(), "piren-ask-shim-"));
    const shim = join(shimDir, "pi");
    await writeFile(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakePiScript)});\n`);
    await chmod(shim, 0o755);
  });

  it("resolves the agent fallback policy and emits the advisory + fallback reply", () => {
    const result = runPirenAsk(["fallbackerr please", "--agent", "dipu"], {
      HOME: home,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(result.status).toBe(0);
    // Bounded non-secret stdout advisory before the fallback reply.
    expect(result.stdout).toContain("[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]");
    // The fallback reply ran on the switched model (same client proof).
    expect(result.stdout).toContain("Fbk openai/gpt-4.1");
    expect(result.stderr).toBe("");
  });

  it("no fallback declaration stays inert (no advisory, no policy read side effects)", async () => {
    // The same agent with no model.fallback block: the CLI run behaves
    // exactly as before (no advisory line, no fallback reply).
    const agentConfig = join(vault, "team", "dipu", "config.yml");
    const original = await readFile(agentConfig, "utf8");
    try {
      await writeFile(agentConfig, "model:\n  id: kimi-coding/k3\n");
      const result = runPirenAsk(["fallbackerr please", "--agent", "dipu"], {
        HOME: home,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("model fallback:");
      expect(result.stdout).not.toContain("Fbk");
      expect(result.stderr).toBe("");
    } finally {
      await writeFile(agentConfig, original);
    }
  });
});
