import { mkdtemp, link, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoom, appendRoomEvent, listRooms, readRoom } from "../src/rooms.js";

describe("rooms core", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-rooms-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a room with a Room Manifest index.md under collaboration/rooms/<id>/", async () => {
    const now = () => new Date("2026-08-02T14:00:00.000Z");
    const result = await createRoom({
      vaultRoot: root,
      title: "Release planning",
      participants: ["kimi", "sam"],
      now,
    });

    expect(result.id).toBe("20260802T140000000Z-release-planning");
    expect(result.path).toBe("collaboration/rooms/20260802T140000000Z-release-planning/index.md");

    const content = await readFile(join(root, result.path), "utf8");
    expect(content).toContain("type: Room Manifest");
    expect(content).toContain("id: 20260802T140000000Z-release-planning");
    expect(content).toContain('title: "Release planning"');
    expect(content).toContain("created_by: steward");
    expect(content).toContain("status: open");
    expect(content).toContain("created: 2026-08-02T14:00:00.000Z");
    expect(content).toContain("updated: 2026-08-02T14:00:00.000Z");
    expect(content).toContain("- kimi");
    expect(content).toContain("- sam");
    expect(content).toContain("# Release planning");
  });

  it("rejects an empty title, invalid participants, and duplicate participants", async () => {
    await expect(createRoom({ vaultRoot: root, title: "   " })).rejects.toThrow("Room title is required");
    await expect(createRoom({ vaultRoot: root, title: "x", participants: ["Bad_Name"] })).rejects.toThrow(
      "Invalid agent name",
    );
    await expect(createRoom({ vaultRoot: root, title: "x", participants: ["kimi", "kimi"] })).rejects.toThrow(
      "Duplicate room participant",
    );
  });

  it("fails closed when the room directory already exists", async () => {
    const now = () => new Date("2026-08-02T14:00:00.000Z");
    await createRoom({ vaultRoot: root, title: "Release planning", now });
    await expect(createRoom({ vaultRoot: root, title: "Release planning", now })).rejects.toThrow(
      "Room already exists",
    );
  });

  it("reads back a room manifest and lists rooms newest-created last without scanning arbitrary paths", async () => {
    const first = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    await createRoom({
      vaultRoot: root,
      title: "Beta room",
      now: () => new Date("2026-08-02T15:00:00.000Z"),
    });

    const room = await readRoom({ vaultRoot: root, roomId: first.id });
    expect(room.id).toBe(first.id);
    expect(room.title).toBe("Alpha room");
    expect(room.createdBy).toBe("steward");
    expect(room.participants).toEqual(["kimi"]);
    expect(room.status).toBe("open");
    expect(room.created).toBe("2026-08-02T14:00:00.000Z");

    const listed = await listRooms({ vaultRoot: root });
    expect(listed.map((entry) => entry.title)).toEqual(["Alpha room", "Beta room"]);
  });

  it("returns an empty list when the collaboration tree does not exist yet", async () => {
    await expect(listRooms({ vaultRoot: root })).resolves.toEqual([]);
  });

  it("rejects a malformed manifest naming its path", async () => {
    const now = () => new Date("2026-08-02T14:00:00.000Z");
    const room = await createRoom({ vaultRoot: root, title: "Alpha room", now });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, room.path), "---\ntype: Task\n---\n# Not a manifest\n", "utf8");
    await expect(readRoom({ vaultRoot: root, roomId: room.id })).rejects.toThrow(room.id);
  });

  it("rejects a manifest whose frontmatter id differs from the requested room id", async () => {
    const now = () => new Date("2026-08-02T14:00:00.000Z");
    const room = await createRoom({ vaultRoot: root, title: "Alpha room", now });
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(join(root, room.path), "utf8");
    await writeFile(join(root, room.path), original.replace(`id: ${room.id}`, "id: forged-other-id"), "utf8");
    await expect(readRoom({ vaultRoot: root, roomId: room.id })).rejects.toThrow(room.path);
  });

  it("rejects a listed room whose directory name differs from its manifest id", async () => {
    const now = () => new Date("2026-08-02T14:00:00.000Z");
    const room = await createRoom({ vaultRoot: root, title: "Alpha room", now });
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(join(root, room.path), "utf8");
    await writeFile(join(root, room.path), original.replace(`id: ${room.id}`, "id: forged-other-id"), "utf8");
    await expect(listRooms({ vaultRoot: root })).rejects.toThrow(room.path);
  });

  it("appends an immutable event and omits optional fields when undefined", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const event = await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: "Please review the plan.",
      addressedAgent: "kimi",
      now: () => new Date("2026-08-02T14:05:00.000Z"),
      nonce: () => "abc123",
    });

    expect(event.id).toBe("20260802T140500000Z-steward-message-abc123");
    expect(event.path).toBe(`collaboration/rooms/${room.id}/events/${event.id}.md`);

    const content = await readFile(join(root, event.path), "utf8");
    expect(content).toContain("type: Room Event");
    expect(content).toContain(`id: ${event.id}`);
    expect(content).toContain(`room: ${room.id}`);
    expect(content).toContain("created: 2026-08-02T14:05:00.000Z");
    expect(content).toContain("author_kind: steward");
    expect(content).toContain("author: steward");
    expect(content).toContain("kind: steward_message");
    expect(content).toContain("addressed_agent: kimi");
    expect(content).not.toContain("correlation_id");
    expect(content).toContain("Please review the plan.");

    const correlated = await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "agent_message",
      authorKind: "agent",
      author: "kimi",
      body: "Reviewed.",
      correlationId: event.id,
      now: () => new Date("2026-08-02T14:06:00.000Z"),
      nonce: () => "def456",
    });
    const correlatedContent = await readFile(join(root, correlated.path), "utf8");
    expect(correlatedContent).toContain(`correlation_id: ${event.id}`);
    expect(correlatedContent).not.toContain("addressed_agent");
  });

  it("rejects unknown kind, bad author combinations, traversal room ids, misplaced addressed_agent, and empty body without writing", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const base = {
      vaultRoot: root,
      roomId: room.id,
      kind: "agent_message" as const,
      authorKind: "agent" as const,
      author: "kimi",
      body: "Hi",
    };
    await expect(appendRoomEvent({ ...base, kind: "run_exploded" as never })).rejects.toThrow("Unknown room event kind");
    await expect(appendRoomEvent({ ...base, authorKind: "steward" as const })).rejects.toThrow("author");
    await expect(appendRoomEvent({ ...base, roomId: "../escape" })).rejects.toThrow("Invalid room id");
    await expect(appendRoomEvent({ ...base, addressedAgent: "kimi" })).rejects.toThrow("steward_message");
    await expect(appendRoomEvent({ ...base, body: "   " })).rejects.toThrow("body");
    await expect(appendRoomEvent({ ...base, roomId: "no-such-room" })).rejects.toThrow("no-such-room");

    const eventsDir = join(root, "collaboration", "rooms", room.id, "events");
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(eventsDir)).resolves.toEqual([]);
  });

  it("rejects a duplicate event id without clobbering the original evidence", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const fixed = {
      vaultRoot: root,
      roomId: room.id,
      kind: "run_started" as const,
      authorKind: "system" as const,
      author: "system",
      body: "Run started.",
      now: () => new Date("2026-08-02T14:05:00.000Z"),
      nonce: () => "abc123",
    };
    const first = await appendRoomEvent(fixed);
    await expect(appendRoomEvent(fixed)).rejects.toThrow("already exists");
    const content = await readFile(join(root, first.path), "utf8");
    expect(content).toContain("Run started.");
  });

  it("rejects an event append when the final-target link reports EEXIST, leaving no file or temp behind", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const eexist = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    const io = {
      linkNoClobber: async () => {
        throw eexist;
      },
      remove: async (path: string) => {
        await rm(path, { force: true });
      },
    };
    await expect(
      appendRoomEvent({
        vaultRoot: root,
        roomId: room.id,
        kind: "steward_message",
        authorKind: "steward",
        author: "steward",
        body: "Hello",
        now: () => new Date("2026-08-02T14:05:00.000Z"),
        nonce: () => "abc123",
        io,
      }),
    ).rejects.toThrow("already exists");

    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, "collaboration", "rooms", room.id, "events"))).resolves.toEqual([]);
  });

  it("settles a controlled concurrent event-append race with exactly one winner and preserved bytes", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    // Barrier: the first link waits until the second writer arrives, then
    // links and signals completion; the second writer links only after the
    // first link completed, so its real link must fail EEXIST. A
    // rename-based overwrite would let both writers "succeed".
    let secondArrived!: () => void;
    let firstLinked!: () => void;
    const gate = new Promise<void>((resolve) => {
      secondArrived = resolve;
    });
    const linked = new Promise<void>((resolve) => {
      firstLinked = resolve;
    });
    let calls = 0;
    const io = {
      linkNoClobber: async (tempPath: string, targetPath: string) => {
        calls += 1;
        if (calls === 1) {
          await gate;
          await link(tempPath, targetPath);
          firstLinked();
        } else {
          secondArrived();
          await linked;
          await link(tempPath, targetPath);
        }
      },
      remove: async (path: string) => {
        await rm(path, { force: true });
      },
    };
    const base = {
      vaultRoot: root,
      roomId: room.id,
      kind: "steward_message" as const,
      authorKind: "steward" as const,
      author: "steward",
      now: () => new Date("2026-08-02T14:05:00.000Z"),
      nonce: () => "abc123",
      io,
    };
    const [first, second] = await Promise.allSettled([
      appendRoomEvent({ ...base, body: "Writer one wins." }),
      appendRoomEvent({ ...base, body: "Writer two loses." }),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("already exists");

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ path: string }>).value;
    const content = await readFile(join(root, winner.path), "utf8");
    expect(content).toContain("Writer one wins.");
    expect(content).not.toContain("Writer two loses.");
  });

  it("settles a controlled concurrent createRoom race with exactly one winner and preserved manifest", async () => {
    let secondArrived!: () => void;
    let firstLinked!: () => void;
    const gate = new Promise<void>((resolve) => {
      secondArrived = resolve;
    });
    const linked = new Promise<void>((resolve) => {
      firstLinked = resolve;
    });
    let calls = 0;
    const io = {
      linkNoClobber: async (tempPath: string, targetPath: string) => {
        calls += 1;
        if (calls === 1) {
          await gate;
          await link(tempPath, targetPath);
          firstLinked();
        } else {
          secondArrived();
          await linked;
          await link(tempPath, targetPath);
        }
      },
      remove: async (path: string) => {
        await rm(path, { force: true });
      },
    };
    const base = { vaultRoot: root, title: "Race room", now: () => new Date("2026-08-02T14:00:00.000Z"), io };
    const [first, second] = await Promise.allSettled([
      createRoom({ ...base, participants: ["kimi"] }),
      createRoom({ ...base, participants: ["thor"] }),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("Room already exists");

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ path: string }>).value;
    const content = await readFile(join(root, winner.path), "utf8");
    expect(content).toContain("- kimi");
    expect(content).not.toContain("- thor");
  });

  it("rejects every kind/author_kind mismatch from the ADR-0041 vocabulary", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const base = { vaultRoot: root, roomId: room.id, body: "x" };
    // steward_message must be steward-authored.
    await expect(
      appendRoomEvent({ ...base, kind: "steward_message", authorKind: "agent", author: "kimi" }),
    ).rejects.toThrow("steward_message");
    // agent_message must be agent-authored.
    await expect(
      appendRoomEvent({ ...base, kind: "agent_message", authorKind: "system", author: "system" }),
    ).rejects.toThrow("agent_message");
    await expect(
      appendRoomEvent({ ...base, kind: "agent_message", authorKind: "steward", author: "steward" }),
    ).rejects.toThrow("agent_message");
    // run_* events must be system-authored.
    for (const kind of ["run_started", "run_finished", "run_cancelled"] as const) {
      await expect(appendRoomEvent({ ...base, kind, authorKind: "agent", author: "kimi" })).rejects.toThrow(
        kind,
      );
      await expect(
        appendRoomEvent({ ...base, kind, authorKind: "steward", author: "steward" }),
      ).rejects.toThrow(kind);
    }

    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, "collaboration", "rooms", room.id, "events"))).resolves.toEqual([]);
  });

  it("rejects orphan and self correlation ids with no write", async () => {
    const room = await createRoom({
      vaultRoot: root,
      title: "Alpha room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const base = {
      vaultRoot: root,
      roomId: room.id,
      kind: "agent_message" as const,
      authorKind: "agent" as const,
      author: "kimi",
      body: "Reply",
      now: () => new Date("2026-08-02T14:06:00.000Z"),
      nonce: () => "self99",
    };
    // Orphan: names no existing event in the room.
    await expect(appendRoomEvent({ ...base, correlationId: "20260802T130000000Z-steward-message-nope00" })).rejects.toThrow(
      "correlation_id",
    );
    // Self: names the id this very append would generate.
    await expect(
      appendRoomEvent({ ...base, correlationId: "20260802T140600000Z-agent-message-self99" }),
    ).rejects.toThrow("itself");

    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, "collaboration", "rooms", room.id, "events"))).resolves.toEqual([]);
  });
});
