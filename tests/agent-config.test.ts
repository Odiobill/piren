import { describe, expect, it } from "vitest";
import { readAgentConfigFileBestEffort, readAgentConfigFileRaw, type AgentConfigReadDeps } from "../src/agent-config.js";

function depsWith(result: string | Error): AgentConfigReadDeps {
  return {
    readFile: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("readAgentConfigFileRaw", () => {
  it("returns the parsed top-level mapping", async () => {
    const config = await readAgentConfigFileRaw("/any/config.yml", depsWith("model:\n  id: anthropic/x\n  thinking: low\n"));
    expect(config).toEqual({ model: { id: "anthropic/x", thinking: "low" } });
  });

  it("propagates read-file errors so the run path keeps rejecting missing config", async () => {
    await expect(readAgentConfigFileRaw("/missing/config.yml", depsWith(new Error("ENOENT: no such file")))).rejects.toThrow("ENOENT");
  });

  it("propagates YAML parse errors so the run path keeps rejecting malformed config", async () => {
    await expect(readAgentConfigFileRaw("/bad/config.yml", depsWith("model:\n  id: [unclosed\n"))).rejects.toThrow();
  });

  it("returns null for empty, scalar, or sequence YAML (not a mapping)", async () => {
    await expect(readAgentConfigFileRaw("/c", depsWith(""))).resolves.toBeNull();
    await expect(readAgentConfigFileRaw("/c", depsWith("just a string\n"))).resolves.toBeNull();
    await expect(readAgentConfigFileRaw("/c", depsWith("- a\n- b\n"))).resolves.toBeNull();
  });
});

describe("readAgentConfigFileBestEffort", () => {
  it("returns the parsed mapping when readable", async () => {
    const config = await readAgentConfigFileBestEffort("/any/config.yml", depsWith("self_improvement:\n  auto_nudge: true\n"));
    expect(config).toEqual({ self_improvement: { auto_nudge: true } });
  });

  it("returns null when the file is missing or unreadable instead of rejecting", async () => {
    await expect(readAgentConfigFileBestEffort("/missing/config.yml", depsWith(new Error("ENOENT: no such file")))).resolves.toBeNull();
  });

  it("returns null for malformed YAML instead of rejecting", async () => {
    await expect(readAgentConfigFileBestEffort("/bad/config.yml", depsWith("model:\n  id: [unclosed\n"))).resolves.toBeNull();
  });

  it("returns null for non-mapping YAML", async () => {
    await expect(readAgentConfigFileBestEffort("/c", depsWith("- a\n- b\n"))).resolves.toBeNull();
  });
});
