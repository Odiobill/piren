import { describe, expect, it } from "vitest";
import { resolveFeedback, DEFAULT_FEEDBACK, type TransportFeedbackConfig } from "../src/transport-feedback.js";

describe("resolveFeedback (transport feedback config normalization)", () => {
  it("returns defaults when no feedback block is configured", () => {
    const result = resolveFeedback(undefined);
    expect(result).toEqual(DEFAULT_FEEDBACK);
    expect(result.enabled).toBe(true);
    expect(result.reactionOnReceive).toBe("👀");
    expect(result.reactionOnComplete).toBe("✅");
    expect(result.typingWhileWorking).toBe(true);
  });

  it("returns defaults when feedback.enabled is not explicitly false", () => {
    const result = resolveFeedback({});
    expect(result.enabled).toBe(true);
  });

  it("disables all feedback when enabled is false", () => {
    const result = resolveFeedback({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  it("honors a custom receive emoji while keeping other defaults", () => {
    const result = resolveFeedback({ reaction_on_receive: "🤖" });
    expect(result.reactionOnReceive).toBe("🤖");
    expect(result.reactionOnComplete).toBe(DEFAULT_FEEDBACK.reactionOnComplete);
    expect(result.typingWhileWorking).toBe(true);
  });

  it("honors a custom complete emoji", () => {
    const result = resolveFeedback({ reaction_on_complete: "🎉" });
    expect(result.reactionOnComplete).toBe("🎉");
  });

  it("honors typing_while_working false", () => {
    const result = resolveFeedback({ typing_while_working: false });
    expect(result.typingWhileWorking).toBe(false);
  });

  it("normalizes all snake_case keys to camelCase", () => {
    const cfg: TransportFeedbackConfig = {
      enabled: true,
      reaction_on_receive: "🟢",
      reaction_on_complete: "🏁",
      typing_while_working: false,
    };
    const result = resolveFeedback(cfg);
    expect(result).toEqual({
      enabled: true,
      reactionOnReceive: "🟢",
      reactionOnComplete: "🏁",
      typingWhileWorking: false,
    });
  });

  it("empty reaction_on_receive string keeps the default rather than sending nothing", () => {
    const result = resolveFeedback({ reaction_on_receive: "" });
    expect(result.reactionOnReceive).toBe("👀");
  });
});
