import { describe, expect, it } from "vitest";
import { buildConversationAgentsResponse } from "../src/conversation-agents.js";

/**
 * ADR-0043 decommission — Conversation-neutral local-policy roster core.
 * `online` is local installation policy only — membership in this gateway's
 * already-resolved runnableAgents set. It is NOT Pi-process presence,
 * provider reachability, transport state, or identity. The roster is
 * explicitly supplied; no config reread, no directory creation, no probing,
 * no polling.
 */
describe("buildConversationAgentsResponse (pure roster)", () => {
  it("marks only runnable agents online; all other vault-defined names are offline", () => {
    const result = buildConversationAgentsResponse(["piren", "researcher", "heimdall"], ["piren"]);
    expect(result).toEqual({
      agents: [
        { name: "heimdall", online: false },
        { name: "piren", online: true },
        { name: "researcher", online: false },
      ],
    });
  });

  it("sorts deterministically by name", () => {
    const result = buildConversationAgentsResponse(["zeta", "alpha", "mike"], ["alpha"]);
    expect(result.agents.map((agent) => agent.name)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("deduplicates supplied names", () => {
    const result = buildConversationAgentsResponse(["piren", "piren", "thor"], ["piren"]);
    expect(result.agents).toHaveLength(2);
    expect(result.agents.filter((agent) => agent.name === "piren")).toHaveLength(1);
  });

  it("returns an empty roster for an empty vault roster (no invented members)", () => {
    expect(buildConversationAgentsResponse([], ["piren"])).toEqual({ agents: [] });
  });

  it("never adds runnable agents absent from the vault roster (the roster drives membership)", () => {
    const result = buildConversationAgentsResponse(["thor"], ["piren", "thor"]);
    expect(result.agents).toEqual([{ name: "thor", online: true }]);
    expect(result.agents.some((agent) => agent.name === "piren")).toBe(false);
  });
});
