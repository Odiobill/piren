import { describe, expect, it } from "vitest";
import { chunkDiscordMessage, DISCORD_MESSAGE_LIMIT } from "../src/discord-transport.js";

describe("chunkDiscordMessage", () => {
  it("uses a 2000-character limit (Discord's hard message limit)", () => {
    expect(DISCORD_MESSAGE_LIMIT).toBe(2000);
  });

  it("returns the text as a single chunk when it fits", () => {
    expect(chunkDiscordMessage("short")).toEqual(["short"]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkDiscordMessage("")).toEqual([]);
  });

  it("splits a long response into chunks that never exceed 2000 and reassemble exactly", () => {
    const text = "line of content\n".repeat(200); // 3200 chars
    const chunks = chunkDiscordMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
    expect(chunks.join("")).toBe(text);
  });
});
