import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLiveItem,
  createSseParser,
  frameToTimelineItem,
  parseRoomEvents,
  replaceHistoricWithEvents,
  type RoomEventRecord,
  type TimelineItem,
} from "../web/src/timeline.js";

/**
 * ADR-0041 R3b-3: inspectable immutable room timeline contract.
 * Historic events are the durable chronological authority; live SSE frames
 * append valid records without client-generated ordering; reconnects re-read
 * the whole history (no replay) and re-subscribe; malformed/unknown SSE data
 * becomes a displayable non-authoritative status item (never a crash, never
 * a mutation); no storage, no writes, no client-side truth.
 */
const webSrc = join(process.cwd(), "web", "src");

function event(overrides: Partial<RoomEventRecord>): RoomEventRecord {
  return {
    id: "e1",
    roomId: "room-1",
    created: "2026-08-03T10:00:00.000Z",
    authorKind: "agent",
    author: "piren",
    kind: "agent_message",
    body: "hello",
    path: "collaboration/rooms/room-1/events/e1.md",
    ...overrides,
  };
}

describe("parseRoomEvents", () => {
  it("accepts the documented {events: [...]} shape", () => {
    expect(parseRoomEvents({ events: [event({ id: "a" }), event({ id: "b" })] })).toHaveLength(2);
    expect(parseRoomEvents({ events: [] })).toEqual([]);
  });

  it("rejects malformed responses fail-closed", () => {
    expect(() => parseRoomEvents(null)).toThrow();
    expect(() => parseRoomEvents({})).toThrow();
    expect(() => parseRoomEvents({ events: "nope" })).toThrow();
    expect(() => parseRoomEvents({ events: [{ id: "x" }] })).toThrow();
    expect(() => parseRoomEvents({ events: [event({ kind: 7 as unknown as string })] })).toThrow();
  });
});

describe("createSseParser", () => {
  it("parses a complete frame in one push", () => {
    const parser = createSseParser();
    const frames = parser.push('event: room_event\ndata: {"id":"e1"}\n\n');
    expect(frames).toEqual([{ event: "room_event", data: '{"id":"e1"}' }]);
  });

  it("buffers partial frames across pushes", () => {
    const parser = createSseParser();
    expect(parser.push("event: room_ev")).toEqual([]);
    expect(parser.push('ent\ndata: {"id":"e')).toEqual([]);
    expect(parser.push('1"}\n\n')).toEqual([{ event: "room_event", data: '{"id":"e1"}' }]);
  });

  it("joins multi-line data lines", () => {
    const parser = createSseParser();
    const frames = parser.push("event: room_event\ndata: {\"a\":1\ndata: ,\"b\":2}\n\n");
    expect(frames).toEqual([{ event: "room_event", data: '{"a":1\n,"b":2}' }]);
  });

  it("ignores comment lines (heartbeats) and yields no frame for them", () => {
    const parser = createSseParser();
    expect(parser.push(": heartbeat\n\n")).toEqual([]);
    const frames = parser.push(': heartbeat\nevent: approval\ndata: {"requestId":"r1"}\n\n');
    expect(frames).toEqual([{ event: "approval", data: '{"requestId":"r1"}' }]);
  });
});

describe("frameToTimelineItem", () => {
  it("maps a valid room_event frame to an event item", () => {
    const item = frameToTimelineItem({ event: "room_event", data: JSON.stringify(event({ id: "live-1" })) });
    expect(item).not.toBeNull();
    expect(item?.type).toBe("event");
    expect(item?.id).toBe("live-1");
  });

  it("maps a valid approval frame to an approval item", () => {
    const data = JSON.stringify({ roomId: "room-1", agent: "piren", requestId: "req-1", method: "confirm" });
    const item = frameToTimelineItem({ event: "approval", data });
    expect(item?.type).toBe("approval");
    expect(item?.id).toBe("approval-req-1");
  });

  it("never throws on malformed data: emits a non-authoritative error item", () => {
    const malformed = frameToTimelineItem({ event: "room_event", data: "not-json" });
    expect(malformed?.type).toBe("error");
    const unknown = frameToTimelineItem({ event: "mystery", data: "{}" });
    expect(unknown?.type).toBe("error");
    expect(() => frameToTimelineItem({ event: "room_event", data: "{}" })).not.toThrow();
    expect(frameToTimelineItem({ event: "room_event", data: "{}" })?.type).toBe("error");
  });

  it("returns null for heartbeat/comment-only frames", () => {
    expect(frameToTimelineItem({ event: "", data: "" })).toBeNull();
  });
});

describe("timeline reducer", () => {
  const historic = [event({ id: "h1" }), event({ id: "h2" })];

  it("appendLiveItem appends a new valid live event without client-generated ordering", () => {
    let items: TimelineItem[] = [];
    items = appendLiveItem(items, { type: "event", id: "l1", event: event({ id: "l1" }) });
    items = appendLiveItem(items, { type: "event", id: "l2", event: event({ id: "l2" }) });
    expect(items.map((item) => item.id)).toEqual(["l1", "l2"]);
  });

  it("appendLiveItem dedupes by id (no duplicate live records on re-read/reconnect)", () => {
    let items: TimelineItem[] = [];
    items = appendLiveItem(items, { type: "event", id: "dup", event: event({ id: "dup" }) });
    const again = appendLiveItem(items, { type: "event", id: "dup", event: event({ id: "dup" }) });
    expect(again).toBe(items);
    expect(again).toHaveLength(1);
  });

  it("appendLiveItem always appends error items (per-frame diagnostics are not deduped)", () => {
    let items: TimelineItem[] = [];
    items = appendLiveItem(items, { type: "error", id: "err-1", message: "bad frame" });
    items = appendLiveItem(items, { type: "error", id: "err-2", message: "bad frame" });
    expect(items).toHaveLength(2);
  });

  it("replaceHistoricWithEvents replaces event/approval items with the durable sequence and keeps error markers", () => {
    const before: TimelineItem[] = [
      { type: "event", id: "stale", event: event({ id: "stale" }) },
      { type: "approval", id: "approval-old", approval: { roomId: "room-1", agent: "piren", requestId: "old", method: "confirm" } },
      { type: "error", id: "err-1", message: "malformed frame seen" },
    ];
    const after = replaceHistoricWithEvents(before, historic);
    expect(after.map((item) => item.id)).toEqual(["err-1", "h1", "h2"]);
  });

  it("replaceHistoricWithEvents never duplicates an id that a live frame already appended", () => {
    const before: TimelineItem[] = [{ type: "event", id: "h2", event: event({ id: "h2" }) }];
    const after = replaceHistoricWithEvents(before, historic);
    expect(after.map((item) => item.id)).toEqual(["h1", "h2"]);
    expect(after).toHaveLength(2);
  });
});

describe("timeline source surface (static)", () => {
  it("uses only the authorized room event + stream reads and no forbidden surface", async () => {
    const files = await readdir(webSrc, { recursive: true });
    const tsFiles = files.filter((f) => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx"))) as string[];
    let combined = "";
    for (const f of tsFiles) combined += (await readFile(join(webSrc, f), "utf8")) + "\n";
    // Authorized reads: historic events + the scoped SSE stream.
    expect(combined).toContain("/events");
    expect(combined).toContain("/events/stream");
    // Forbidden in R3b-3: writes, other API surfaces, storage, native SSE client.
    for (const forbidden of ["/messages", "/approve", "/abort", "/api/vault", "/api/chat", "new EventSource", "localStorage", "sessionStorage", "thinking"]) {
      expect(combined, `${forbidden} must not appear in the R3b-3 surface`).not.toContain(forbidden);
    }
  });

  it("RoomTimeline distinguishes loading/error/empty/live/connecting/disconnected states with one polite live region", async () => {
    const sources = new Map<string, string>();
    const files = await readdir(webSrc, { recursive: true });
    for (const f of files) {
      if (typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx"))) {
        sources.set(f, await readFile(join(webSrc, f), "utf8"));
      }
    }
    const timeline = sources.get("RoomTimeline.tsx") ?? "";
    expect(timeline.length).toBeGreaterThan(0);
    for (const marker of ["loading", "error", "empty", "live", "disconnected", "aria-live=\"polite\""]) {
      expect(timeline, `RoomTimeline must render a ${marker} state/marker`).toContain(marker);
    }
    // Exactly one polite live region (no repeated token/body announcements).
    expect((timeline.match(/aria-live="polite"/g) ?? []).length).toBe(1);
    // RoomNavigator mounts the timeline in the room detail view.
    const navigator = sources.get("RoomNavigator.tsx") ?? "";
    expect(navigator).toContain("RoomTimeline");
  });
});
