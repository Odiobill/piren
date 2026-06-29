import { describe, expect, it } from "vitest";
import { parseArgs, KNOWN_COMMANDS } from "../src/parse-args.js";

describe("parseArgs: flags after the command", () => {
  it("parses --force after the command (piren clean --force)", () => {
    // Regression: the old parser broke out of the scan loop on the command
    // token, so --force appearing AFTER "clean" was never read. This caused
    // `piren clean --force` to silently do a dry run.
    const result = parseArgs(["clean", "--force"]);
    expect(result.command).toBe("clean");
    expect(result.force).toBe(true);
  });

  it("parses --apply after the command (piren setup --apply)", () => {
    // Same class of bug: --apply after the command was swallowed.
    const result = parseArgs(["setup", "--apply"]);
    expect(result.command).toBe("setup");
    expect(result.apply).toBe(true);
  });

  it("parses --port and --host after the command (piren gateway --port 7317 --host 0.0.0.0)", () => {
    const result = parseArgs(["gateway", "--port", "7317", "--host", "0.0.0.0"]);
    expect(result.command).toBe("gateway");
    expect(result.port).toBe(7317);
    expect(result.host).toBe("0.0.0.0");
  });

  it("parses --token after the command (piren gateway --token abc123)", () => {
    const result = parseArgs(["gateway", "--token", "abc123"]);
    expect(result.command).toBe("gateway");
    expect(result.token).toBe("abc123");
  });

  it("parses --token before the command", () => {
    const result = parseArgs(["--token", "abc123", "gateway"]);
    expect(result.command).toBe("gateway");
    expect(result.token).toBe("abc123");
  });

  it("parses --agent after the command without swallowing its value into positionals (piren ask --agent thor hi)", () => {
    // The --agent flag takes the next token as its value, so "thor" must NOT
    // appear in positionals. Only the free message token "hi" should.
    const result = parseArgs(["ask", "--agent", "thor", "hi"]);
    expect(result.command).toBe("ask");
    expect(result.agentName).toBe("thor");
    expect(result.positionals).toEqual(["hi"]);
  });

  it("parses --vault-root after the command", () => {
    const result = parseArgs(["status", "--vault-root", "/tmp/vault"]);
    expect(result.command).toBe("status");
    expect(result.vaultRoot).toBe("/tmp/vault");
  });
});

describe("parseArgs: positionals after the command", () => {
  it("collects multiple positionals as the message for ask", () => {
    const result = parseArgs(["ask", "hello", "world"]);
    expect(result.command).toBe("ask");
    expect(result.positionals).toEqual(["hello", "world"]);
  });

  it("does not collect flag tokens as positionals", () => {
    const result = parseArgs(["ask", "--force", "hi"]);
    expect(result.force).toBe(true);
    expect(result.positionals).toEqual(["hi"]);
  });
});

describe("parseArgs: preserved behavior", () => {
  it("defaults command to status when no command is given", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("status");
    expect(result.positionals).toEqual([]);
  });

  it("parses flags before the command", () => {
    const result = parseArgs(["--force", "clean"]);
    expect(result.command).toBe("clean");
    expect(result.force).toBe(true);
  });

  it("parses --agent before the command", () => {
    const result = parseArgs(["--agent", "thor", "ask", "hi"]);
    expect(result.command).toBe("ask");
    expect(result.agentName).toBe("thor");
    expect(result.positionals).toEqual(["hi"]);
  });

  it("parses equals-form global flags like --agent=thor", () => {
    const result = parseArgs(["status", "--vault-root=/tmp/vault", "--agent=thor"]);
    expect(result.command).toBe("status");
    expect(result.vaultRoot).toBe("/tmp/vault");
    expect(result.agentName).toBe("thor");
  });

  it("parses equals-form command flags used by setup --apply", () => {
    const result = parseArgs([
      "setup",
      "--apply",
      "--provider=deepseek",
      "--model=deepseek-v4-flash",
      "--thinking=minimal",
      "--api-key=sk-test",
    ]);
    expect(result.command).toBe("setup");
    expect(result.apply).toBe(true);
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.thinking).toBe("minimal");
    expect(result.apiKey).toBe("sk-test");
  });

  it("preserves -- passthrough after the command", () => {
    const result = parseArgs(["run", "--", "--print", "hello"]);
    expect(result.command).toBe("run");
    expect(result.piArgs).toEqual(["--print", "hello"]);
  });

  it("preserves -- passthrough with flags before the command", () => {
    const result = parseArgs(["--agent", "thor", "run", "--", "--print", "hello"]);
    expect(result.command).toBe("run");
    expect(result.agentName).toBe("thor");
    expect(result.piArgs).toEqual(["--print", "hello"]);
  });

  it("exposes the known command list", () => {
    expect(KNOWN_COMMANDS).toContain("clean");
    expect(KNOWN_COMMANDS).toContain("ask");
    expect(KNOWN_COMMANDS).toContain("chat");
    expect(KNOWN_COMMANDS).toContain("gateway");
    expect(KNOWN_COMMANDS).toContain("telegram");
    expect(KNOWN_COMMANDS).toContain("discord");
  });

  it("recognizes the version command", () => {
    const result = parseArgs(["version"]);
    expect(result.command).toBe("version");
    expect(KNOWN_COMMANDS).toContain("version");
  });

  it("sets help=true for --help anywhere before the -- passthrough", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["gateway", "--help"]).help).toBe(true);
    expect(parseArgs(["-h", "run"]).help).toBe(true);
  });

  it("does not set help for --help after the -- passthrough (forwarded to Pi)", () => {
    const result = parseArgs(["run", "--", "--help"]);
    expect(result.help).toBe(false);
    expect(result.piArgs).toEqual(["--help"]);
  });

  it("recognizes the service command", () => {
    const result = parseArgs(["service", "install", "gateway"]);
    expect(result.command).toBe("service");
    expect(result.positionals).toEqual(["install", "gateway"]);
    expect(KNOWN_COMMANDS).toContain("service");
  });

  it("recognizes the agent command with subcommands and positionals", () => {
    expect(parseArgs(["agent", "add", "thor"]).command).toBe("agent");
    expect(parseArgs(["agent", "add", "thor"]).positionals).toEqual(["add", "thor"]);
    expect(parseArgs(["agent", "clone", "piren", "thor"]).positionals).toEqual(["clone", "piren", "thor"]);
    expect(KNOWN_COMMANDS).toContain("agent");
  });

  it("parses --yes / -y as a confirmation flag (for non-interactive agent remove)", () => {
    expect(parseArgs(["agent", "remove", "thor", "--yes"]).yes).toBe(true);
    expect(parseArgs(["agent", "remove", "thor", "-y"]).yes).toBe(true);
    expect(parseArgs(["agent", "remove", "thor"]).yes).toBe(false);
  });
});
