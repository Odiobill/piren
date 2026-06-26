import { describe, expect, it } from "vitest";
import { buildAgentConfigYaml, type AgentConfigInput } from "../src/wizard.js";

describe("buildAgentConfigYaml", () => {
  it("writes a model block with id and thinking", () => {
    const input: AgentConfigInput = {
      model: { id: "anthropic/claude-sonnet-4-6", thinking: "medium" },
    };
    const yaml = buildAgentConfigYaml(input);
    expect(yaml).toContain("model:");
    expect(yaml).toContain("id: anthropic/claude-sonnet-4-6");
    expect(yaml).toContain("thinking: medium");
  });

  it("writes a model block without thinking when omitted", () => {
    const yaml = buildAgentConfigYaml({ model: { id: "openai/gpt-5.2" } });
    expect(yaml).toContain("model:");
    expect(yaml).toContain("id: openai/gpt-5.2");
    expect(yaml).not.toContain("thinking:");
  });

  it("omits the model block entirely when no model is provided", () => {
    const yaml = buildAgentConfigYaml({});
    expect(yaml).not.toContain("model:");
    expect(yaml).toContain("poll_interval_active_seconds");
    expect(yaml).toContain("poll_interval_idle_seconds");
  });

  it("preserves a comment header explaining the file purpose", () => {
    const yaml = buildAgentConfigYaml({ model: { id: "google/gemini-3-pro-preview" } });
    expect(yaml.toLowerCase()).toMatch(/agent.*config|preferences/);
  });
});
