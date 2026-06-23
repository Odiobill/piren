import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askAgent } from "../src/ask.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("askAgent against a fake Pi RPC process", () => {
  it("streams tokens live and returns assembled text", async () => {
    const tokens: string[] = [];
    const text = await askAgent(fakePiTarget(), "Hello", (token) => {
      tokens.push(token);
    });

    expect(text).toBe("Hello");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("")).toBe("Hello");
  });

  it("surfaces prompt errors", async () => {
    // The fake Pi process rejects prompts containing "fail".
    await expect(askAgent(fakePiTarget(), "please fail this prompt")).rejects.toThrow(
      /prompt rejected|fail trigger/i,
    );
  });
});
