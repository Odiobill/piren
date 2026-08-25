import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS,
  parseWorkbenchConfig,
  workbenchRunDeadlineMs,
} from "../src/workbench-config.js";

/**
 * VR-2 — closed vault-root `workbench.yml` contract (accepted
 * Projects/Piren/workbench-video-capture-readiness-contract.md §6).
 *
 * The ONE defined key is `conversation.run_timeout_seconds`:
 *   - absent file / absent mapping / absent key -> 3600, no warning;
 *   - valid positive integer 1..3600 -> that value, no warning;
 *   - malformed YAML / wrong type / out-of-range -> 3600 + exactly one
 *     bounded non-secret warning naming only the key path and a category;
 *   - unknown keys are ignored (the file is steward-managed and never
 *     rewritten, so non-mutation preserves them).
 */

function warningsOf(source: string | null): string[] {
  return parseWorkbenchConfig(source).warnings.map((w) => `${w.key ?? "-"}:${w.category}`);
}

describe("parseWorkbenchConfig — resolution table", () => {
  it("absent file resolves to the 3600-second default with no warning", () => {
    const result = parseWorkbenchConfig(null);
    expect(result.conversationRunTimeoutSeconds).toBe(3600);
    expect(result.warnings).toEqual([]);
  });

  it("empty file resolves to the default with no warning", () => {
    const result = parseWorkbenchConfig("");
    expect(result.conversationRunTimeoutSeconds).toBe(3600);
    expect(result.warnings).toEqual([]);
  });

  it("missing conversation mapping and missing key resolve to the default with no warning", () => {
    expect(parseWorkbenchConfig("other:\n  key: 1\n").conversationRunTimeoutSeconds).toBe(3600);
    expect(parseWorkbenchConfig("conversation:\n  other_key: 5\n").conversationRunTimeoutSeconds).toBe(3600);
    for (const source of ["other:\n  key: 1\n", "conversation:\n  other_key: 5\n"]) {
      expect(parseWorkbenchConfig(source).warnings).toEqual([]);
    }
  });

  it.each([1, 30, 3599, 3600])("valid integer %i resolves exactly with no warning", (value) => {
    const source = `conversation:\n  run_timeout_seconds: ${value}\n`;
    const result = parseWorkbenchConfig(source);
    expect(result.conversationRunTimeoutSeconds).toBe(value);
    expect(result.warnings).toEqual([]);
  });

  it("malformed YAML resolves to the default with exactly one bounded malformed-yaml warning", () => {
    const result = parseWorkbenchConfig("conversation:\n  run_timeout_seconds: [unclosed\n");
    expect(result.conversationRunTimeoutSeconds).toBe(DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS);
    expect(warningsOf("conversation:\n  run_timeout_seconds: [unclosed\n")).toEqual([
      "-:malformed-yaml",
    ]);
  });

  it("a non-mapping document resolves to the default with one malformed-yaml warning", () => {
    const result = parseWorkbenchConfig("- just\n- a\n- list\n");
    expect(result.conversationRunTimeoutSeconds).toBe(3600);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.category).toBe("malformed-yaml");
  });

  it.each([
    ["a string value", 'conversation:\n  run_timeout_seconds: "600"\n', "wrong-type"],
    ["a boolean", "conversation:\n  run_timeout_seconds: true\n", "wrong-type"],
    ["null", "conversation:\n  run_timeout_seconds: null\n", "wrong-type"],
    ["a float", "conversation:\n  run_timeout_seconds: 90.5\n", "wrong-type"],
    ["a nested mapping", "conversation:\n  run_timeout_seconds:\n    x: 1\n", "wrong-type"],
  ])("%s is wrong-type: default plus one bounded warning", (_label, source, category) => {
    const result = parseWorkbenchConfig(source);
    expect(result.conversationRunTimeoutSeconds).toBe(3600);
    expect(warningsOf(source)).toEqual([`conversation.run_timeout_seconds:${category}`]);
  });

  it.each([[0], [-1], [3601], [86400]])("out-of-range %i resolves to the default with an out-of-range warning", (value) => {
    const source = `conversation:\n  run_timeout_seconds: ${value}\n`;
    const result = parseWorkbenchConfig(source);
    expect(result.conversationRunTimeoutSeconds).toBe(3600);
    expect(warningsOf(source)).toEqual(["conversation.run_timeout_seconds:out-of-range"]);
  });

  it("warnings are bounded and non-secret: they name only the key path and a category", () => {
    const secretish = 'token: "super-secret-value"\nconversation:\n  run_timeout_seconds: "nope"\n';
    const text = JSON.stringify(parseWorkbenchConfig(secretish));
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("/");
  });
});

describe("unknown-key preservation by non-mutation", () => {
  it("the parser returns no serialized form and exposes no writer — nothing can rewrite the steward-managed file", () => {
    const result = parseWorkbenchConfig("anything:\n  goes: here\n");
    // Closed shape: no writer output, no file content, no extra keys.
    expect(Object.keys(result).sort()).toEqual(["conversationRunTimeoutSeconds", "warnings"]);
    expect(result.conversationRunTimeoutSeconds).toBe(3600);
    expect(result.warnings).toEqual([]);
  });
});

describe("workbenchRunDeadlineMs", () => {
  it("converts resolved seconds to milliseconds", () => {
    expect(workbenchRunDeadlineMs(parseWorkbenchConfig(null))).toBe(3_600_000);
    expect(workbenchRunDeadlineMs(parseWorkbenchConfig("conversation:\n  run_timeout_seconds: 45\n"))).toBe(45_000);
  });
});
