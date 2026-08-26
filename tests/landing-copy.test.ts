import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L2 landing-page static regression: the marketing page must lead with the
 * shared-vault narrative and carry no competitor/comparison framing.
 */
const root = process.cwd();
const landing = readFileSync(join(root, "site/index.html"), "utf8");

describe("landing shared-vault narrative (L2)", () => {
  it("removes the comparison section, its nav link, and competitor names", () => {
    expect(landing).not.toContain('id="compare"');
    expect(landing).not.toContain('href="#compare"');
    expect(landing).not.toContain("How it compares");
    expect(landing).not.toContain("Hermes Agent");
    expect(landing).not.toContain("OpenClaw");
    expect(landing).not.toContain("vs database-backed agents");
  });

  it("leads with the shared-vault hero thesis", () => {
    expect(landing).toContain("grounded in a shared vault");
    expect(landing).toContain("local-first, vault-native");
    expect(landing).toContain("edge-friendly");
  });
});
