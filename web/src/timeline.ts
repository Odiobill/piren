/**
 * Shared web transport utilities preserved from the decommissioned Rooms
 * timeline module (ADR-0043 2026-08-14): the generic SSE parser and the
 * bounded reconnect budget used by the Conversation live stream. All
 * room-specific parsing/timeline types were removed with the Rooms product.
 */

/** One parsed SSE frame (event name + joined data payload). */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser. Buffers partial chunks, splits on
 * blank lines, joins multi-line data, and ignores comment lines (`: ...`,
 * including the gateway's `: heartbeat`). Comment-only blocks yield no
 * frame. Never throws.
 */
export function createSseParser(): { push: (text: string) => SseFrame[] } {
  let buffer = "";
  return {
    push(text: string): SseFrame[] {
      buffer += text;
      const frames: SseFrame[] = [];
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseBlock(block);
        if (frame !== null) frames.push(frame);
      }
      return frames;
    },
  };
}

function parseBlock(block: string): SseFrame | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment (heartbeat)
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
    // id:/retry:/unknown fields are ignored (no client-side replay truth).
  }
  if (dataLines.length === 0) return null; // comment-only block
  return { event, data: dataLines.join("\n") };
}

/** Reconnect budget scoped to a selection / manual reconnect lifecycle. */
export const MAX_AUTO_RECONNECT_ATTEMPTS = 1;

export interface ReconnectBudget {
  attemptsUsed: number;
}

export function initialReconnectBudget(): ReconnectBudget {
  return { attemptsUsed: 0 };
}

/**
 * A stream ended unexpectedly. Exactly one automatic whole-history
 * reread + re-subscription is allowed per lifecycle; after it, only an
 * explicit manual Reconnect may retry. Opening a stream NEVER resets this
 * budget — an open/end flapping stream cannot loop forever.
 */
export function streamEnded(budget: ReconnectBudget): {
  budget: ReconnectBudget;
  action: "auto-reconnect" | "manual-reconnect-required";
} {
  if (budget.attemptsUsed < MAX_AUTO_RECONNECT_ATTEMPTS) {
    return { budget: { attemptsUsed: budget.attemptsUsed + 1 }, action: "auto-reconnect" };
  }
  return { budget, action: "manual-reconnect-required" };
}
