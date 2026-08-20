import { describe, expect, it } from "vitest";
import { formatPostSetupWorkbenchSuggestion } from "../src/setup-guidance.js";

/**
 * G1 — bounded post-setup Workbench suggestion
 * (0-2-0-scope-amendment §7): after a SUCCESSFUL `piren setup` the operator
 * may be told they can start the Workbench with `piren gateway` (default
 * bind localhost). The message is text only: it names the exact command,
 * states the localhost default bind truthfully, is framed as optional, and
 * never implies the Workbench is already running. Callers gate emission;
 * this pure formatter only owns the wording.
 */
describe("formatPostSetupWorkbenchSuggestion (G1, bounded text-only)", () => {
  it("names the exact `piren gateway` command and its default localhost bind", () => {
    const text = formatPostSetupWorkbenchSuggestion();
    expect(text).toContain("piren gateway");
    expect(text).toContain("localhost");
  });

  it("is framed as an optional operator action and never implies the Workbench is running", () => {
    const text = formatPostSetupWorkbenchSuggestion();
    expect(text.toLowerCase()).toContain("optional");
    expect(text).toContain("not running");
    // Never an assurance of a running service or an automatic action.
    expect(text.toLowerCase()).not.toContain("is running on");
    expect(text.toLowerCase()).not.toContain("started");
  });

  it("is concise and contains no secrets, tokens, or URLs", () => {
    const text = formatPostSetupWorkbenchSuggestion();
    expect(text.split("\n").length).toBeLessThanOrEqual(4);
    expect(text.toLowerCase()).not.toContain("token");
    expect(text.toLowerCase()).not.toContain("http://");
    expect(text.toLowerCase()).not.toContain("https://");
  });
});
