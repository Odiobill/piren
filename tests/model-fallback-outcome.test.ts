import { describe, expect, it } from "vitest";
import {
  classifyRunOutcome,
  isFallbackEligibleOutcome,
  type ProviderErrorOutcome,
  type RunOutcome,
} from "../src/model-fallback-outcome.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

// Compile-time guards (checked by tsc in typecheck/build):
// - RunOutcome is a genuine discriminated union (each member's category is a
//   distinct literal), so a category check narrows the record.
// - ProviderErrorOutcome["category"] is EXACTLY the two eligible literals
//   (never `never`), so isFallbackEligibleOutcome narrows to a usable subtype.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _RunOutcomeIsDiscriminatedUnion = Assert<
  Equal<
    RunOutcome,
    | { category: "completed"; detail: string }
    | { category: "aborted"; detail: string }
    | { category: "ambiguous"; detail: string }
    | { category: "provider_error_transient_exhausted"; detail: string }
    | { category: "provider_error_other"; detail: string }
  >
>;
type _ProviderErrorCategoryEquals = Assert<
  Equal<ProviderErrorOutcome["category"], "provider_error_transient_exhausted" | "provider_error_other">
>;

// TB2 pure event-stream classifier (Projects/Piren/model-fallbacks-design.md
// §3.1). agent_settled is mandatory for any normal terminal classification;
// structured fields only (no errorMessage text / HTTP-status inference);
// zero-side-effect gate; maintenance traffic never triggers fallback;
// ADR-0038 launch_failure stays OUTSIDE this event-only core.

function errEvents(extra: RpcEvent[] = [], errorMessage: unknown = "quota exceeded"): RpcEvent[] {
  const assistant = { role: "assistant", content: [], stopReason: "error", errorMessage };
  return [
    { type: "message_start", message: { role: "user", content: "hi" } },
    { type: "message_start", message: assistant },
    { type: "message_end", message: assistant },
    { type: "turn_end", message: assistant, toolResults: [] },
    { type: "agent_end", messages: [assistant], willRetry: false },
    ...extra,
    { type: "agent_settled" },
  ];
}

function textDelta(delta = "oops"): RpcEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

const SAMPLE_ERROR_TEXT = "OpenAI API error (401): secret-provider-body";

describe("classifyRunOutcome", () => {
  it("requires agent_settled: any stream without it is ambiguous (agent_end alone is never terminal)", () => {
    expect(classifyRunOutcome([{ type: "agent_end", messages: [], willRetry: false }]).category).toBe("ambiguous");
    expect(classifyRunOutcome([{ type: "agent_end", messages: [], willRetry: true }]).category).toBe("ambiguous");
    expect(classifyRunOutcome([{ type: "agent_start" }, textDelta("Partial")]).category).toBe("ambiguous");
    expect(classifyRunOutcome([]).category).toBe("ambiguous");
  });

  it("classifies a settled run with no terminal assistant message as completed", () => {
    const outcome = classifyRunOutcome([
      { type: "agent_start" },
      textDelta("Hel"),
      textDelta("lo"),
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "completed" });
    expect(outcome.detail.length).toBeGreaterThan(0);
  });

  it("classifies structured normal terminal stop reasons after settlement as completed", () => {
    for (const stopReason of ["stop", "length", "toolUse"]) {
      const outcome = classifyRunOutcome([
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [], stopReason } },
        { type: "message_end", message: { role: "assistant", content: [], stopReason } },
        { type: "turn_end", message: { role: "assistant", content: [], stopReason }, toolResults: [] },
        { type: "agent_settled" },
      ]);
      expect(outcome.category, `expected completed for ${stopReason}`).toBe("completed");
    }
  });

  it("classifies a structured aborted stop reason as aborted (never fallback-safe)", () => {
    const outcome = classifyRunOutcome([
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "aborted" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("classifies a zero-side-effect provider error without retry marker as provider_error_other", () => {
    const outcome = classifyRunOutcome(errEvents());
    expect(outcome).toMatchObject({ category: "provider_error_other" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(true);
  });

  it("classifies provider_error_transient_exhausted ONLY from auto_retry_end success:false", () => {
    const exhausted = classifyRunOutcome(errEvents([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }]));
    expect(exhausted.category).toBe("provider_error_other"); // start alone proves nothing

    const success = classifyRunOutcome(
      errEvents([
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3 },
        { type: "auto_retry_end", success: true, attempt: 1 },
      ]),
    );
    expect(success.category).toBe("provider_error_other"); // success:true never proves exhaustion

    const failed = classifyRunOutcome(
      errEvents([
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3 },
        { type: "auto_retry_start", attempt: 2, maxAttempts: 3 },
        { type: "auto_retry_end", success: false, attempt: 3 },
      ]),
    );
    expect(failed).toMatchObject({ category: "provider_error_transient_exhausted" });
    expect(isFallbackEligibleOutcome(failed)).toBe(true);
  });

  it("treats any text delta as side-effect contamination: provider error becomes ambiguous, never completed", () => {
    const outcome = classifyRunOutcome(errEvents([textDelta("oops")]));
    expect(outcome).toMatchObject({ category: "ambiguous" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("treats any tool_execution_* as side-effect contamination: ambiguous", () => {
    const outcome = classifyRunOutcome(
      errEvents([{ type: "tool_execution_start", toolName: "vault_read", args: {} }]),
    );
    expect(outcome.category).toBe("ambiguous");
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("treats any extension_ui_request as side-effect contamination: ambiguous", () => {
    const outcome = classifyRunOutcome(errEvents([{ type: "extension_ui_request", id: "r1", method: "confirm" }]));
    expect(outcome.category).toBe("ambiguous");
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("fails closed when the provider error has no structured errorMessage field", () => {
    const assistant = { role: "assistant", content: [], stopReason: "error" };
    const outcome = classifyRunOutcome([
      { type: "message_end", message: assistant },
      { type: "turn_end", message: assistant, toolResults: [] },
      { type: "agent_end", messages: [assistant], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome.category).toBe("ambiguous");
  });

  it("fails closed when the errorMessage field is present but not a string", () => {
    const outcome = classifyRunOutcome(errEvents([], 42));
    expect(outcome.category).toBe("ambiguous");
  });

  it("fails closed on an unknown or malformed final stop reason", () => {
    const unknown = classifyRunOutcome([
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "weird" } },
      { type: "agent_settled" },
    ]);
    expect(unknown.category).toBe("ambiguous");

    const missing = classifyRunOutcome([
      { type: "message_end", message: { role: "assistant", content: [] } },
      { type: "agent_settled" },
    ]);
    expect(missing.category).toBe("ambiguous");
  });

  it("keeps overflow-compaction maintenance traffic non-triggering: settled completion stays completed", () => {
    const outcome = classifyRunOutcome([
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: false, willRetry: true },
      { type: "agent_start" },
      textDelta("Pre"),
      textDelta("Post"),
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "completed" });
  });

  it("fails closed when failed/aborted compaction or summarization traffic never reaches agent_settled", () => {
    const compact = classifyRunOutcome([
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", aborted: false, result: null },
      { type: "agent_end", messages: [], willRetry: false },
    ]);
    expect(compact.category).toBe("ambiguous");

    const summarization = classifyRunOutcome([
      { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3 },
      { type: "summarization_retry_attempt_start", source: "compaction" },
      { type: "summarization_retry_finished" },
      { type: "agent_end", messages: [], willRetry: false },
    ]);
    expect(summarization.category).toBe("ambiguous");
  });

  it("deterministically uses the last structured assistant terminal record across a retry", () => {
    const outcome = classifyRunOutcome([
      { type: "agent_start" },
      { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "x" }], willRetry: true },
      { type: "agent_start" },
      { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "completed" });
  });

  it("never leaks raw error text or model ids into the detail", () => {
    const outcome = classifyRunOutcome(errEvents([], SAMPLE_ERROR_TEXT));
    expect(outcome.detail).not.toContain(SAMPLE_ERROR_TEXT);
    expect(outcome.detail).not.toMatch(/401|403|429|5\d\d/i);
  });

  it("fails closed when the authoritative final agent_end.messages mixes stopReason:error with a normal terminal record", () => {
    const error = { role: "assistant", content: [], stopReason: "error", errorMessage: "x" };
    const normal = { role: "assistant", content: ["done"], stopReason: "stop" };
    const outcome = classifyRunOutcome([
      { type: "agent_start" },
      { type: "agent_end", messages: [error, normal], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "ambiguous" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("fails closed when the authoritative final agent_end.messages mixes stopReason:error with aborted", () => {
    const error = { role: "assistant", content: [], stopReason: "error", errorMessage: "x" };
    const aborted = { role: "assistant", content: [], stopReason: "aborted" };
    const outcome = classifyRunOutcome([
      { type: "agent_end", messages: [error, aborted], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "ambiguous" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("does NOT treat multiple consistent error records in the final run as a conflict", () => {
    const errorA = { role: "assistant", content: [], stopReason: "error", errorMessage: "x" };
    const errorB = { role: "assistant", content: [], stopReason: "error", errorMessage: "y" };
    const outcome = classifyRunOutcome([
      { type: "agent_end", messages: [errorA, errorB], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "provider_error_other" });
  });

  it("keeps an earlier willRetry:true error followed by a later final normal stop as completed (conflict scope is the final low-level run only)", () => {
    const outcome = classifyRunOutcome([
      { type: "agent_start" },
      { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "x" }], willRetry: true },
      { type: "agent_start" },
      { type: "agent_end", messages: [{ role: "assistant", content: ["ok"], stopReason: "stop" }], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "completed" });
  });

  it("keeps a normal toolUse->stop sequence in the final run as completed (not a conflict)", () => {
    const outcome = classifyRunOutcome([
      { type: "agent_end", messages: [
        { role: "assistant", content: [], stopReason: "toolUse" },
        { role: "assistant", content: ["done"], stopReason: "stop" },
      ], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "completed" });
  });

  it("regression: a non-assistant turn_end record cannot become provider-error/eligible; fails closed as ambiguous", () => {
    // RpcEvent is deliberately loose and raw JSONL is cast into it. A malformed
    // terminal turn_end record with role:"user" must never satisfy the
    // structured assistant-message requirement.
    const malformedUser = {
      type: "turn_end",
      message: { role: "user", stopReason: "error", errorMessage: "x" },
      toolResults: [],
    } as unknown as RpcEvent;
    const outcome = classifyRunOutcome([malformedUser, { type: "agent_settled" }]);
    expect(outcome).toMatchObject({ category: "ambiguous" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("regression: a non-record turn_end message is malformed terminal evidence and fails closed as ambiguous", () => {
    const malformed = { type: "turn_end", message: "not-a-record", toolResults: [] } as unknown as RpcEvent;
    const outcome = classifyRunOutcome([malformed, { type: "agent_settled" }]);
    expect(outcome).toMatchObject({ category: "ambiguous" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("regression: a malformed non-assistant turn_end with an empty final agent_end stays ambiguous, never completed", () => {
    const malformedUser = {
      type: "turn_end",
      message: { role: "user", stopReason: "error", errorMessage: "x" },
      toolResults: [],
    } as unknown as RpcEvent;
    const outcome = classifyRunOutcome([
      malformedUser,
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "ambiguous" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("keeps valid assistant turn_end-only provider-error and normal cases unchanged", () => {
    const errorOutcome = classifyRunOutcome([
      { type: "turn_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "x" }, toolResults: [] },
      { type: "agent_settled" },
    ]);
    expect(errorOutcome).toMatchObject({ category: "provider_error_other" });
    expect(isFallbackEligibleOutcome(errorOutcome)).toBe(true);

    const normalOutcome = classifyRunOutcome([
      { type: "turn_end", message: { role: "assistant", content: ["ok"], stopReason: "stop" }, toolResults: [] },
      { type: "agent_settled" },
    ]);
    expect(normalOutcome).toMatchObject({ category: "completed" });
  });

  it("side-effect contamination wins over the exhaustion marker: ambiguous, never transient_exhausted", () => {
    const outcome = classifyRunOutcome(
      errEvents([
        { type: "auto_retry_end", success: false, attempt: 3 },
        textDelta("oops"),
      ]),
    );
    expect(outcome.category).toBe("ambiguous");
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("settled normal completion with side-effect traffic stays completed", () => {
    const outcome = classifyRunOutcome([
      textDelta("Pre"),
      { type: "tool_execution_start", toolName: "vault_read" },
      { type: "tool_execution_end", toolName: "vault_read" },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "completed" });
  });

  it("a structured aborted stop reason stays aborted even with side effects (abort is not gated on side effects)", () => {
    const outcome = classifyRunOutcome([
      textDelta("Partial"),
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } },
      { type: "agent_settled" },
    ]);
    expect(outcome).toMatchObject({ category: "aborted" });
    expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });
});

describe("isFallbackEligibleOutcome", () => {
  it("is true ONLY for fully settled zero-side-effect provider-error categories", () => {
    const eligible: RunOutcome[] = [
      { category: "provider_error_other", detail: "d" },
      { category: "provider_error_transient_exhausted", detail: "d" },
    ];
    const notEligible: RunOutcome[] = [
      { category: "completed", detail: "d" },
      { category: "aborted", detail: "d" },
      { category: "ambiguous", detail: "d" },
    ];
    for (const outcome of eligible) expect(isFallbackEligibleOutcome(outcome)).toBe(true);
    for (const outcome of notEligible) expect(isFallbackEligibleOutcome(outcome)).toBe(false);
  });

  it("narrows to a genuine provider-error discriminated subtype, never `never` (type-level)", () => {
    // Compile-time equality guards at the top of this file prove
    // ProviderErrorOutcome["category"] is exactly the two eligible literals.
    // Runtime: the narrowed branch is reachable and its category is restricted
    // to the two eligible values.
    const outcome: RunOutcome = { category: "provider_error_other", detail: "d" };
    if (isFallbackEligibleOutcome(outcome)) {
      expect(["provider_error_other", "provider_error_transient_exhausted"]).toContain(outcome.category);
      expect(outcome.detail.length).toBeGreaterThan(0);
    } else {
      throw new Error("narrowing should have held");
    }
    // And a completed outcome can never pass the predicate.
    const completed: RunOutcome = { category: "completed", detail: "d" };
    expect(isFallbackEligibleOutcome(completed)).toBe(false);
  });
});
