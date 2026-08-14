// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createSseParser,
  initialReconnectBudget,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  streamEnded,
  type ReconnectBudget,
} from "../web/src/timeline.js";

/**
 * ADR-0043 decommission — shared web transport utilities preserved from the
 * old Rooms timeline module and used by the Conversation live stream: the
 * generic SSE parser and the bounded reconnect budget. The room-specific
 * timeline/parser types were removed with the Rooms product (no
 * compatibility layer).
 */

describe("createSseParser (shared)", () => {
  it("parses a single complete frame", () => {
    const parser = createSseParser();
    expect(parser.push('event: conversation_event\ndata: {"id":"e1"}\n\n')).toEqual([
      { event: "conversation_event", data: '{"id":"e1"}' },
    ]);
  });

  it("buffers partial chunks and splits on blank lines", () => {
    const parser = createSseParser();
    expect(parser.push("event: conversation_ev")).toEqual([]);
    expect(parser.push('ent\ndata: {"id":"e')).toEqual([]);
    expect(parser.push('1"}\n\n')).toEqual([{ event: "conversation_event", data: '{"id":"e1"}' }]);
  });

  it("joins multi-line data and ignores comment/heartbeat lines", () => {
    const parser = createSseParser();
    const frames = parser.push(": heartbeat\nevent: conversation_event\ndata: {\"a\":1\ndata: ,\"b\":2}\n\n");
    expect(frames).toEqual([{ event: "conversation_event", data: '{"a":1\n,"b":2}' }]);
  });

  it("comment-only blocks yield no frame", () => {
    const parser = createSseParser();
    expect(parser.push(": heartbeat\n\n")).toEqual([]);
  });
});

describe("reconnect budget (open/end flapping is bounded)", () => {
  it("the first stream end triggers one automatic reconnect", () => {
    const result = streamEnded(initialReconnectBudget());
    expect(result.action).toBe("auto-reconnect");
    expect(result.budget).toEqual({ attemptsUsed: 1 });
  });

  it("two open/end cycles trigger exactly one automatic reconnect (no open reset)", () => {
    let budget: ReconnectBudget = initialReconnectBudget();
    let result = streamEnded(budget);
    budget = result.budget;
    expect(result.action).toBe("auto-reconnect");
    result = streamEnded(budget);
    expect(result.action).toBe("manual-reconnect-required");
    expect(result.budget).toEqual({ attemptsUsed: 1 });
  });

  it("the budget caps at one automatic attempt per selection/manual-reconnect lifecycle", () => {
    expect(MAX_AUTO_RECONNECT_ATTEMPTS).toBe(1);
    expect(initialReconnectBudget()).toEqual({ attemptsUsed: 0 });
    const afterAuto = streamEnded(initialReconnectBudget()).budget;
    expect(streamEnded(afterAuto).action).toBe("manual-reconnect-required");
  });
});
