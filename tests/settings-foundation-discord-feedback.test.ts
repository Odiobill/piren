import { describe, expect, it } from "vitest";
import { readLocalConfigRedacted, type SettingsFoundationIo } from "../src/settings-foundation.js";

/**
 * W5 (0.2.0 amendment §5.1): the §5.1 inventory lists feedback for BOTH
 * transports. The W4 discord projection was missing `feedbackEnabled`; W5
 * adds it (additive) so the discord read returns the same redacted feedback
 * state as telegram. Never a token, raw config, or fingerprint.
 */

function ioWith(text: string): SettingsFoundationIo {
  const map = new Map([["/tmp/config.yml", text]]);
  return {
    readFile: async (path) => {
      const value = map.get(path);
      if (value === undefined) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return value;
    },
    writeFile: async () => {},
    fsync: async () => {},
    rename: async () => {},
    unlink: async () => {},
  };
}

describe("RedactedDiscordProjection.feedbackEnabled (W5 additive)", () => {
  it("projects the declared discord feedback.enabled boolean, or null when undeclared", async () => {
    const declared = await readLocalConfigRedacted(
      ioWith("discord:\n  bot_token: D\n  feedback:\n    enabled: false\n"),
      "/tmp/config.yml",
    );
    expect(declared.discord?.feedbackEnabled).toBe(false);

    const undeclared = await readLocalConfigRedacted(ioWith("discord:\n  bot_token: D\n"), "/tmp/config.yml");
    expect(undeclared.discord?.feedbackEnabled).toBe(null);
  });

  it("never projects the token or a feedback reaction string", async () => {
    const result = await readLocalConfigRedacted(
      ioWith("discord:\n  bot_token: SECRET\n  feedback:\n    enabled: true\n    reaction_on_complete: '\\u2705'\n"),
      "/tmp/config.yml",
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("reaction_on_complete");
    expect(result.discord?.feedbackEnabled).toBe(true);
  });
});
