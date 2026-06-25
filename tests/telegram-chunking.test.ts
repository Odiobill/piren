import { describe, expect, it } from "vitest";
import { chunkTelegramMessage, TELEGRAM_MESSAGE_LIMIT } from "../src/telegram-transport.js";

describe("chunkTelegramMessage", () => {
  it("returns the text as a single chunk when it fits the limit", () => {
    expect(chunkTelegramMessage("short")).toEqual(["short"]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkTelegramMessage("")).toEqual([]);
  });

  it("splits a long text on newlines without exceeding the limit", () => {
    const para = "line of content\n".repeat(100); // 1600 chars, 100 lines
    const text = para + para + para; // 4800 chars
    const chunks = chunkTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    // chunks reassemble to the original (splitting preserves the separators)
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits a run of characters longer than the limit with no newline", () => {
    const text = "x".repeat(TELEGRAM_MESSAGE_LIMIT + 500);
    const chunks = chunkTelegramMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.length).toBe(TELEGRAM_MESSAGE_LIMIT);
    expect(chunks[1]?.length).toBe(500);
    expect(chunks.join("")).toBe(text);
  });

  it("splits a single paragraph larger than the limit on word boundaries when possible", () => {
    const words = "word ".repeat(1200); // 6000 chars, single logical paragraph
    const text = words.trim();
    const chunks = chunkTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    // substrings reassemble to the original exactly
    expect(chunks.join("")).toBe(text);
  });
});
