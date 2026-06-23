import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiRunCommand } from "../src/run.js";

let root: string;
let vault: string;
let agentDir: string;
let configPath: string;

async function makeFixture(agentConfig: string) {
  root = await mkdtemp(join(tmpdir(), "piren-run-"));
  vault = join(root, "vault");
  agentDir = join(vault, "team", "piren");
  configPath = join(root, "config.yml");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(agentDir, "inbox"), { recursive: true });
  await mkdir(join(agentDir, "outbox"), { recursive: true });
  await mkdir(join(agentDir, "logs"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  await writeFile(join(vault, "steward-directives.md"), "# Steward\n");
  await writeFile(join(agentDir, "SOUL.md"), "# Piren\n");
  await writeFile(join(agentDir, "MEMORY.md"), "# Memory\n");
  await writeFile(join(agentDir, "config.yml"), agentConfig);
  await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - piren\n`);
}

beforeEach(async () => {
  await makeFixture("model:\n  id: anthropic/claude-sonnet-4-20250514\n  thinking: medium\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("piren run command construction", () => {
  it("builds a Pi command from compact agent-local model config", async () => {
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [] });

    expect(command.command).toBe("npx");
    expect(command.args).toEqual([
      "pi",
      "--extension",
      "./src/pi-extension.ts",
      "--vault-root",
      vault,
      "--agent",
      "piren",
      "--model",
      "anthropic/claude-sonnet-4-20250514:medium",
    ]);
  });

  it("builds a Pi model flag from expanded provider plus id config", async () => {
    await writeFile(join(agentDir, "config.yml"), "model:\n  provider: anthropic\n  id: claude-sonnet-4-20250514\n  thinking: medium\n");

    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [] });

    expect(command.args).toContain("anthropic/claude-sonnet-4-20250514:medium");
  });

  it("builds a Pi models flag from agent-local models list and forwards extra Pi args", async () => {
    await writeFile(
      join(agentDir, "config.yml"),
      [
        "models:",
        "  - provider: anthropic",
        "    id: claude-sonnet-4-20250514",
        "    thinking: medium",
        "  - provider: openai",
        "    id: gpt-4.1",
        "    thinking: off",
        "",
      ].join("\n"),
    );

    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: ["--print", "hello"] });

    expect(command.args).toEqual([
      "pi",
      "--extension",
      "./src/pi-extension.ts",
      "--vault-root",
      vault,
      "--agent",
      "piren",
      "--models",
      "anthropic/claude-sonnet-4-20250514:medium,openai/gpt-4.1:off",
      "--print",
      "hello",
    ]);
  });

  it("builds a worker Pi command that opts into Piren inbox polling without changing interactive run", async () => {
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], workerMode: true });

    expect(command.args).toEqual([
      "pi",
      "--extension",
      "./src/pi-extension.ts",
      "--vault-root",
      vault,
      "--agent",
      "piren",
      "--model",
      "anthropic/claude-sonnet-4-20250514:medium",
    ]);
    expect(command.env.PIREN_WORKER).toBe("1");
  });

  it("builds a gateway RPC Pi command that activates --mode rpc with piped stdio", async () => {
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], rpcMode: true });

    expect(command.args).toEqual([
      "pi",
      "--extension",
      "./src/pi-extension.ts",
      "--vault-root",
      vault,
      "--agent",
      "piren",
      "--model",
      "anthropic/claude-sonnet-4-20250514:medium",
      "--mode",
      "rpc",
    ]);
    expect(command.stdio).toBe("pipe");
  });

  it("keeps interactive run on inherited stdio and omits --mode rpc by default", async () => {
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [] });

    expect(command.args).not.toContain("rpc");
    expect(command.stdio).toBe("inherit");
  });
});
