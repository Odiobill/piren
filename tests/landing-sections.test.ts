import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L3 landing-page static regression: the marketing page must present the
 * Workbench Conversations and Typed Settings sections with their critical
 * copy boundaries.
 */
const root = process.cwd();
const landing = readFileSync(join(root, "site/index.html"), "utf8");

describe("landing Workbench Conversations and Typed Settings (L3)", () => {
  it("presents the Workbench Conversations section with its boundaries", () => {
    expect(landing).toContain('id="conversations"');
    expect(landing).toContain("two to eight locally runnable agents");
    expect(landing).toContain("no agent is dispatched");
    expect(landing).toContain("validated at the gateway");
    expect(landing).toContain('src="assets/workbench-conversation.png"');
  });

  it("presents the Typed Settings section with its boundaries", () => {
    expect(landing).toContain('id="settings"');
    expect(landing).toContain("This installation");
    expect(landing).toContain("Agent settings");
    expect(landing).toContain("Agent groups");
    expect(landing).toContain("write-only");
    expect(landing).toContain("CLI-only");
    expect(landing).toContain("never written to storage");
    expect(landing).toContain("Not a generic editor");
  });
});
