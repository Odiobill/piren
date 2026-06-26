import { type Readable } from "node:stream";
/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators
 * such as U+2028 and U+2029, which are valid inside JSON strings. Clients must
 * split records on "\n" only.
 */
export declare function serializeJsonLine(value: unknown): string;
/**
 * Attach a strict LF-only JSONL line reader to a stream.
 *
 * This intentionally does not use Node's readline. Readline splits on
 * additional Unicode separators (U+2028, U+2029) that are valid inside JSON
 * strings, so it does not implement strict JSONL framing. We split on "\n"
 * only and trim a single trailing carriage return for CRLF tolerance.
 */
export declare function createJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void;
