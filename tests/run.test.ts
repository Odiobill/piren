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
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], extensionPath: "./src/pi-extension.ts" });

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

    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], extensionPath: "./src/pi-extension.ts" });

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

    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: ["--print", "hello"], extensionPath: "./src/pi-extension.ts" });

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
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], workerMode: true, extensionPath: "./src/pi-extension.ts" });

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
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], rpcMode: true, extensionPath: "./src/pi-extension.ts" });

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
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], extensionPath: "./src/pi-extension.ts" });

    expect(command.args).not.toContain("rpc");
    expect(command.stdio).toBe("inherit");
  });

  it("appends --extension flags for declared packages in declaration order after the core extension", async () => {
    await writeFile(configPath, "vault_root: " + vault + "\n" + "allowed_agents:\n" + "  - piren\n" + "packages:\n" + '  - "@piren/web-search"\n' + '  - "@piren/git-tools"\n');
    const fakeResolver = (name: string) => "/fake/node_modules/" + name + "/dist/index.js";

    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], extensionPath: "./src/pi-extension.ts", packageResolver: fakeResolver });

    // Core extension loads first, then package extensions in declared order.
    const extensionArgs = command.args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--extension") acc.push(command.args[i + 1] ?? "");
      return acc;
    }, []);
    expect(extensionArgs).toEqual([
      "./src/pi-extension.ts",
      "/fake/node_modules/@piren/web-search/dist/index.js",
      "/fake/node_modules/@piren/git-tools/dist/index.js",
    ]);
  });

  it("skips missing packages and only appends resolved extensions", async () => {
    await writeFile(configPath, "vault_root: " + vault + "\n" + "allowed_agents:\n" + "  - piren\n" + "packages:\n" + '  - "@piren/web-search"\n' + '  - "@piren/missing"\n');
    const fakeResolver = (name: string) => {
      if (name === "@piren/missing") throw new Error("Cannot find module '@piren/missing'");
      return "/fake/node_modules/" + name + "/index.js";
    };

    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], extensionPath: "./src/pi-extension.ts", packageResolver: fakeResolver });

    const extensionArgs = command.args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--extension") acc.push(command.args[i + 1] ?? "");
      return acc;
    }, []);
    expect(extensionArgs).toEqual([
      "./src/pi-extension.ts",
      "/fake/node_modules/@piren/web-search/index.js",
    ]);
  });

  it("omits extra --extension flags when no packages are declared", async () => {
    const command = await buildPiRunCommand({ configPath, env: {}, extraArgs: [], extensionPath: "./src/pi-extension.ts" });

    const extensionCount = command.args.filter((arg) => arg === "--extension").length;
    expect(extensionCount).toBe(1);
  });
});
