import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseDispatchOutcome,
  parseMessageError,
  toMessageRequest,
  validateComposerInput,
} from "../web/src/composer.js";

/**
 * ADR-0041 R3b-4 (W1): structured dispatch composer contract. The composer is
 * a Rooms-module surface: it sends the accepted structured {agent, text} body
 * through POST /api/rooms/<id>/messages only, the target agent comes from the
 * selected room's immutable participant record (never rendered @text), the
 * send button is disabled unless a participant is selected and the trimmed
 * text is non-empty, and the UI never invents events, retries, queues, or
 * synthetic run status. Pure helpers are framework-free and fail closed.
 */
const webSrc = join(process.cwd(), "web", "src");

describe("validateComposerInput (pure)", () => {
  it("enables send only for a selected participant with non-empty trimmed text", () => {
    expect(validateComposerInput({ participants: ["piren", "kimi"], selectedAgent: "piren", text: "Hello" })).toEqual({
      ok: true,
    });
    expect(validateComposerInput({ participants: ["piren"], selectedAgent: "piren", text: "  hello  " })).toEqual({
      ok: true,
    });
  });

  it("blocks when the room has no participants", () => {
    const result = validateComposerInput({ participants: [], selectedAgent: "", text: "Hello" });
    expect(result).toEqual({ ok: false, reason: "no participants" });
  });

  it("blocks when no participant is selected or the selection is not a participant", () => {
    expect(validateComposerInput({ participants: ["piren"], selectedAgent: "", text: "Hello" })).toEqual({
      ok: false,
      reason: "select a participant",
    });
    expect(validateComposerInput({ participants: ["piren"], selectedAgent: "kimi", text: "Hello" })).toEqual({
      ok: false,
      reason: "not a participant",
    });
  });

  it("blocks empty or whitespace-only text", () => {
    expect(validateComposerInput({ participants: ["piren"], selectedAgent: "piren", text: "" })).toEqual({
      ok: false,
      reason: "text required",
    });
    expect(validateComposerInput({ participants: ["piren"], selectedAgent: "piren", text: "   " })).toEqual({
      ok: false,
      reason: "text required",
    });
  });
});

describe("toMessageRequest (pure)", () => {
  it("builds the structured {agent, text} body with trimmed text", () => {
    expect(toMessageRequest("piren", "  Run the bounded slice  ")).toEqual({
      agent: "piren",
      text: "Run the bounded slice",
    });
  });
});

describe("parseDispatchOutcome (fail-closed)", () => {
  it("accepts the four documented outcome statuses", () => {
    for (const status of ["completed", "failed", "timed_out", "cancelled"] as const) {
      expect(parseDispatchOutcome({ outcome: { status, roomId: "r1", agent: "piren", stewardEventId: "e1", terminalEventId: "e2" } }).status).toBe(
        status,
      );
    }
  });

  it("rejects malformed or missing outcomes", () => {
    expect(() => parseDispatchOutcome(null)).toThrow();
    expect(() => parseDispatchOutcome({})).toThrow();
    expect(() => parseDispatchOutcome({ outcome: {} })).toThrow();
    expect(() => parseDispatchOutcome({ outcome: { status: "unknown" } })).toThrow();
    expect(() => parseDispatchOutcome({ outcome: { status: "completed" } })).toThrow();
  });
});

describe("parseMessageError (non-secret)", () => {
  it("extracts a non-secret error string and rejects non-string payloads", () => {
    expect(parseMessageError({ error: "An active run exists for this agent." })).toBe(
      "An active run exists for this agent.",
    );
    expect(parseMessageError({ error: 42 })).toBeNull();
    expect(parseMessageError(null)).toBeNull();
    expect(parseMessageError({})).toBeNull();
  });
});

describe("web composer static contract (R3b-4)", () => {
  async function readWebSources(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const name of await readdir(webSrc)) {
      if (name.endsWith(".tsx") || name.endsWith(".ts")) {
        files.set(name, await readFile(join(webSrc, name), "utf8"));
      }
    }
    return files;
  }

  it("ships a RoomComposer component with the structured dispatch surface", async () => {
    const sources = await readWebSources();
    const composer = sources.get("RoomComposer.tsx");
    expect(composer).toBeDefined();
    // The composer is wired into the selected-room view.
    const navigator = sources.get("RoomNavigator.tsx") ?? "";
    expect(navigator).toContain("RoomComposer");
    expect(navigator).toContain("participants={selectedRoom.participants}");
    // The composer announces dispatch success through onAnnounce, so the
    // navigator must render its live region in the selected-room (detail)
    // view too — not only the list view. Pin at least two live regions.
    const liveMatches = navigator.match(/aria-live="polite"/g) ?? [];
    expect(liveMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("makes no stale pre-timeline/pre-composer claims (rework regression)", async () => {
    const sources = await readWebSources();
    const navigator = sources.get("RoomNavigator.tsx") ?? "";
    const composer = sources.get("RoomComposer.tsx") ?? "";
    // The navigator comment must not deny the delivered timeline/composer
    // surfaces; only the real non-goals remain.
    expect(navigator).not.toMatch(/No timeline, composer, dispatch/i);
    expect(navigator).toContain("No approval, abort, vault browser, graph, model controls, cache, or");
    expect(navigator).toContain("service worker");
    // The composer must not claim the timeline is below it (it renders above).
    expect(composer).not.toMatch(/timeline below/i);
    expect(composer).toMatch(/The room timeline shows/i);
  });

  it("sends only through the authenticated structured messages endpoint", async () => {
    const sources = await readWebSources();
    const api = sources.get("api.ts") ?? "";
    const composer = sources.get("RoomComposer.tsx") ?? "";
    expect(api).toContain("sendRoomMessage");
    expect(api).toMatch(/\/api\/rooms\/\$\{encodeURIComponent\(roomId\)\}\/messages/);
    expect(api).toContain('method: "POST"');
    expect(api).toContain("JSON.stringify({ agent, text })");
    // No other room/chat mutation endpoints appear in the composer surface.
    expect(composer).not.toMatch(/\/approve|\/abort|\/api\/chat|\/api\/vault/);
  });

  it("uses a labelled select of room participants and a labelled text input", async () => {
    const composer = (await readWebSources()).get("RoomComposer.tsx") ?? "";
    expect(composer).toMatch(/<label[^>]*>.*Target agent/);
    expect(composer).toContain("<select");
    expect(composer).toMatch(/<label[^>]*>.*Message/);
    expect(composer).toContain('id="composer-text"');
    expect(composer).toContain('name="agent"');
  });

  it("disables the native submit unless a participant is selected and text is non-empty", async () => {
    const composer = (await readWebSources()).get("RoomComposer.tsx") ?? "";
    expect(composer).toContain("disabled={");
    expect(composer).toContain("canSend");
    expect(composer).toContain('type="submit"');
  });

  it("announces errors truthfully with no secrets and keeps the composer free of forbidden controls", async () => {
    const composer = (await readWebSources()).get("RoomComposer.tsx") ?? "";
    expect(composer).toMatch(/role="alert"/);
    expect(composer).toMatch(/aria-live/);
    const lower = composer.toLowerCase();
    for (const forbidden of ["/api/chat", "approve", "abort", "localstorage", "sessionstorage", "task", "model", "provider"]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it("never synthesizes events, retries, queues, or optimistic run status", async () => {
    const composer = (await readWebSources()).get("RoomComposer.tsx") ?? "";
    // No timer/queue primitives, no optimistic event/synthetic run-status writes.
    expect(composer).not.toMatch(/setTimeout|setInterval|queueMicrotask|AbortController\(\)\s*;\s*optimistic/);
    expect(composer).not.toContain("run_started");
    expect(composer).not.toContain("run_finished");
    expect(composer).not.toMatch(/fetch\([^)]*\/events/);
  });
});
