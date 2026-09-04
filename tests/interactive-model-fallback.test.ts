import { describe, expect, it } from "vitest";
import {
  createInteractiveFallbackIncident,
  recordInteractiveFallbackEvent,
  settleInteractiveFallbackIncident,
} from "../src/interactive-model-fallback.js";

describe("interactive model fallback event adapter", () => {
  function settledProviderError() {
    const incident = createInteractiveFallbackIncident();
    recordInteractiveFallbackEvent(incident, "agent_end", {
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider secret/status text" }],
    });
    recordInteractiveFallbackEvent(incident, "agent_settled", {});
    return incident;
  }

  it("permits only an idle, fully settled, zero-side-effect provider error", () => {
    const settled = settleInteractiveFallbackIncident(settledProviderError(), { isIdle: true });

    expect(settled.outcome.category).toBe("provider_error_other");
  });

  it("fails closed when the session is no longer idle at settlement", () => {
    const settled = settleInteractiveFallbackIncident(settledProviderError(), { isIdle: false });

    expect(settled.outcome).toEqual({
      category: "ambiguous",
      detail: "the interactive session was not idle at agent_settled.",
    });
  });

  it("fails closed after any tool execution or malformed extension evidence", () => {
    const toolIncident = settledProviderError();
    recordInteractiveFallbackEvent(toolIncident, "tool_execution_start", { toolCallId: "tool-1", toolName: "write" });
    expect(settleInteractiveFallbackIncident(toolIncident, { isIdle: true }).outcome.category).toBe("ambiguous");

    const malformedIncident = settledProviderError();
    recordInteractiveFallbackEvent(malformedIncident, "message_end", null);
    expect(settleInteractiveFallbackIncident(malformedIncident, { isIdle: true }).outcome.category).toBe("ambiguous");
  });
});
