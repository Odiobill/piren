import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createJsonlLineReader, serializeJsonLine } from "../src/jsonl.js";

function drainLines(stream: PassThrough): { lines: string[] } {
  const lines: string[] = [];
  createJsonlLineReader(stream, (line) => lines.push(line));
  return { lines };
}

describe("jsonl serialization", () => {
  it("serializes a value as a single JSON line terminated by a newline", () => {
    expect(serializeJsonLine({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe("jsonl line reader", () => {
  it("emits one line per LF, splitting on newline only", () => {
    const stream = new PassThrough();
    const { lines } = drainLines(stream);
    stream.write(serializeJsonLine({ a: 1 }));
    stream.write(serializeJsonLine({ b: 2 }));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not split on Unicode line separators inside JSON strings", () => {
    const stream = new PassThrough();
    const { lines } = drainLines(stream);
    const payload = { text: "line one\u2028line two\u2029line three" };
    stream.write(serializeJsonLine(payload));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(payload);
  });

  it("buffers a partial chunk until the next newline arrives", () => {
    const stream = new PassThrough();
    const { lines } = drainLines(stream);
    stream.write('{"part');
    expect(lines).toHaveLength(0);
    stream.write('ial":true}\n');
    expect(lines).toEqual(['{"partial":true}']);
  });

  it("strips a trailing carriage return from CRLF-framed lines", () => {
    const stream = new PassThrough();
    const { lines } = drainLines(stream);
    stream.write('{"ok":true}\r\n');
    expect(lines).toEqual(['{"ok":true}']);
  });

  it("emits a final line without a trailing newline when the stream ends", async () => {
    const stream = new PassThrough();
    const { lines } = drainLines(stream);
    stream.write('{"end":true}');
    const ended = new Promise<void>((resolve) => {
      stream.once("end", resolve);
    });
    stream.end();
    await ended;
    expect(lines).toEqual(['{"end":true}']);
  });
});
