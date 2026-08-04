import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoomAgents, parseRoomList, parseRoomRecord } from "../web/src/rooms.js";

/**
 * ADR-0041 R3b-2: room navigator contract. The navigator consumes only
 * GET /api/room-agents and the room list/create/read routes; offline agents
 * are visible but disabled; no timeline/SSE/composer/approval/abort/vault/
 * graph/model UI and no storage. Pure parsers fail closed.
 */
const webSrc = join(process.cwd(), "web", "src");

describe("web room navigator contract (R3b-2)", () => {
  describe("parseRoomAgents", () => {
    it("accepts the documented roster shape", () => {
      expect(
        parseRoomAgents({ agents: [{ name: "piren", online: true }, { name: "heimdall", online: false }] }),
      ).toEqual({ agents: [{ name: "piren", online: true }, { name: "heimdall", online: false }] });
      expect(parseRoomAgents({ agents: [] })).toEqual({ agents: [] });
    });

    it("rejects malformed rosters fail-closed", () => {
      expect(() => parseRoomAgents(null)).toThrow();
      expect(() => parseRoomAgents({})).toThrow();
      expect(() => parseRoomAgents({ agents: "nope" })).toThrow();
      expect(() => parseRoomAgents({ agents: [{ name: "x" }] })).toThrow();
      expect(() => parseRoomAgents({ agents: [{ online: true }] })).toThrow();
      expect(() => parseRoomAgents({ agents: [{ name: "x", online: "yes" }] })).toThrow();
    });
  });

  describe("parseRoomList", () => {
    it("accepts the documented room list shape", () => {
      const room = {
        id: "r1",
        title: "sync",
        status: "open",
        participants: ["piren"],
        path: "collaboration/rooms/r1",
        createdBy: "steward",
        created: "2026-08-03T00:00:00.000Z",
        updated: "2026-08-03T00:00:00.000Z",
      };
      expect(parseRoomList({ rooms: [room] })).toEqual({ rooms: [room] });
      expect(parseRoomList({ rooms: [] })).toEqual({ rooms: [] });
    });

    it("rejects malformed lists fail-closed", () => {
      expect(() => parseRoomList(null)).toThrow();
      expect(() => parseRoomList({})).toThrow();
      expect(() => parseRoomList({ rooms: "nope" })).toThrow();
      expect(() => parseRoomList({ rooms: [{ title: "x" }] })).toThrow();
    });
  });

  describe("parseRoomRecord", () => {
    it("accepts a room from read/create responses", () => {
      const room = {
        id: "r1",
        title: "sync",
        status: "open",
        participants: ["piren", "researcher"],
        path: "collaboration/rooms/r1",
        createdBy: "steward",
        created: "2026-08-03T00:00:00.000Z",
        updated: "2026-08-03T00:00:00.000Z",
      };
      expect(parseRoomRecord(room)).toEqual(room);
    });

    it("rejects malformed records fail-closed", () => {
      expect(() => parseRoomRecord(null)).toThrow();
      expect(() => parseRoomRecord({ id: "r1" })).toThrow();
      expect(() => parseRoomRecord({ id: "r1", title: "x", status: "open", participants: "piren" })).toThrow();
      expect(() => parseRoomRecord({ id: "r1", title: "x", status: "open", participants: ["piren", 7] })).toThrow();
    });
  });

  describe("navigator source surface (static)", () => {
    it("uses the room-agents roster and room routes, with offline agents labelled and disabled", async () => {
      const files = await readdir(webSrc, { recursive: true });
      const tsFiles = files.filter(
        (f) => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx")),
      ) as string[];
      let combined = "";
      for (const f of tsFiles) combined += (await readFile(join(webSrc, f), "utf8")) + "\n";
      expect(combined).toContain("/api/room-agents");
      expect(combined).toContain("/api/rooms");
      // Offline agents are visibly labelled and cannot be selected.
      expect(combined).toContain("Offline");
      expect(combined).toContain("disabled");
    });

    it("contains no timeline/SSE/composer/approval/abort/vault/graph/model behavior", async () => {
      const files = await readdir(webSrc, { recursive: true });
      const tsFiles = files.filter(
        (f) => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx")),
      ) as string[];
      let combined = "";
      for (const f of tsFiles) combined += (await readFile(join(webSrc, f), "utf8")) + "\n";
      // R3b-2 authorized the roster + room routes; R3b-3 authorized the
      // room event + stream READS; R3b-4 authorized the structured
      // {agent, text} messages POST (composer). Writes and other surfaces
      // stay forbidden.
      for (const forbiddenOfR3b2 of [
        "new EventSource",
        "/approve",
        "/abort",
        "/api/vault",
        "/api/chat",
        "thinking",
      ]) {
        expect(combined, `${forbiddenOfR3b2} must not appear in the R3b-2 navigator surface`).not.toContain(forbiddenOfR3b2);
      }
      // R3b-4 composer: messages POST is the ONLY write surface.
      expect(combined).toContain("/messages");
    });
  });
});
