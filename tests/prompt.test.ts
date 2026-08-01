import { describe, expect, it } from "vitest";
import { createInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import { ReadlinePrompt } from "../src/prompt.js";

// ReadlinePrompt over an injected interface whose stdin delivers all lines in
// a single chunk (piped stdin). rl.question() drops every line after the
// first because only one question listener is attached when the chunk is
// processed; the prompt must buffer lines so scripted/non-TTY input works.

function pipedPrompt(input: string): { prompt: ReadlinePrompt; written: () => string } {
  const stdin = Readable.from([input]);
  let out = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      out += chunk.toString();
      callback();
    },
  });
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return { prompt: new ReadlinePrompt(rl), written: () => out };
}

describe("ReadlinePrompt with piped (single-chunk) stdin", () => {
  it("answers sequential questions from one input chunk", async () => {
    const { prompt } = pipedPrompt("first\nsecond\nthird\n");
    const a = await prompt.text("One");
    const b = await prompt.secret("Two");
    const c = await prompt.text("Three");
    expect(a).toBe("first");
    expect(b).toBe("second");
    expect(c).toBe("third");
    prompt.close();
  });

  it("applies defaults on empty piped lines and resolves menus", async () => {
    const { prompt } = pipedPrompt("\n\n2\ny\n");
    const a = await prompt.text("With default", "the-default");
    const b = await prompt.confirm("Sure?", true);
    const c = await prompt.select("Pick", ["a", "b", "c"]);
    const d = await prompt.confirm("Write?", false);
    expect(a).toBe("the-default");
    expect(b).toBe(true);
    expect(c).toBe(1);
    expect(d).toBe(true);
    prompt.close();
  });

  it("resolves a comma-separated list from piped input", async () => {
    const { prompt } = pipedPrompt("alpha, beta , gamma\n");
    const list = await prompt.list("Items");
    expect(list).toEqual(["alpha", "beta", "gamma"]);
    prompt.close();
  });

  it("writes the prompt text to the output stream", async () => {
    const { prompt, written } = pipedPrompt("x\n");
    await prompt.text("Your name", "anon");
    expect(written()).toContain("Your name [anon]: ");
    prompt.close();
  });
});
