import { mkdtemp, link, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoom, appendRoomEvent, listRoomEvents, listRooms, readRoom } from "../src/rooms.js";

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
      runStatus: "running" as const,
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

    // Both writers target the same event id; arrival order at the link step
    // is intentionally not assumed. Exactly one body may survive, intact.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ path: string }>).value;
    const content = await readFile(join(root, winner.path), "utf8");
    expect(content.includes("Writer one wins.")).not.toBe(content.includes("Writer two loses."));
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

    // Arrival order at the link step is not assumed; exactly one participant
    // list may survive, intact.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ path: string }>).value;
    const content = await readFile(join(root, winner.path), "utf8");
    expect(content.includes("- kimi")).not.toBe(content.includes("- thor"));
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

describe("room run outcome fields", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-rooms-outcome-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeRoom(): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Outcome room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    return room.id;
  }

  it("renders run_status and failure_kind only when valid for the kind", async () => {
    const roomId = await makeRoom();
    const steward = await appendRoomEvent({
      vaultRoot: root,
      roomId,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: "Go.",
      addressedAgent: "kimi",
      now: () => new Date("2026-08-02T14:01:00.000Z"),
      nonce: () => "s1",
    });
    const started = await appendRoomEvent({
      vaultRoot: root,
      roomId,
      kind: "run_started",
      authorKind: "system",
      author: "system",
      body: "Run started.",
      runStatus: "running",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:02:00.000Z"),
      nonce: () => "s2",
    });
    const startedContent = await readFile(join(root, started.path), "utf8");
    expect(startedContent).toContain("run_status: running");
    expect(startedContent).not.toContain("failure_kind");

    const finished = await appendRoomEvent({
      vaultRoot: root,
      roomId,
      kind: "run_finished",
      authorKind: "system",
      author: "system",
      body: "Run failed.",
      runStatus: "failed",
      failureKind: "launch_failure",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:03:00.000Z"),
      nonce: () => "s3",
    });
    const finishedContent = await readFile(join(root, finished.path), "utf8");
    expect(finishedContent).toContain("run_status: failed");
    expect(finishedContent).toContain("failure_kind: launch_failure");

    const cancelled = await appendRoomEvent({
      vaultRoot: root,
      roomId,
      kind: "run_cancelled",
      authorKind: "system",
      author: "system",
      body: "Run cancelled.",
      runStatus: "cancelled",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:04:00.000Z"),
      nonce: () => "s4",
    });
    const cancelledContent = await readFile(join(root, cancelled.path), "utf8");
    expect(cancelledContent).toContain("run_status: cancelled");
    expect(cancelledContent).not.toContain("failure_kind");
  });

  it("rejects every invalid kind/run-outcome combination without a write", async () => {
    const roomId = await makeRoom();
    const base = { vaultRoot: root, roomId, body: "x" };
    // message kinds reject all run-outcome fields
    await expect(
      appendRoomEvent({ ...base, kind: "steward_message", authorKind: "steward", author: "steward", runStatus: "running" }),
    ).rejects.toThrow("run outcome");
    await expect(
      appendRoomEvent({ ...base, kind: "agent_message", authorKind: "agent", author: "kimi", failureKind: "ambiguous" }),
    ).rejects.toThrow("run outcome");
    // run_started requires run_status: running and nothing else
    await expect(
      appendRoomEvent({ ...base, kind: "run_started", authorKind: "system", author: "system" }),
    ).rejects.toThrow("run_status");
    await expect(
      appendRoomEvent({ ...base, kind: "run_started", authorKind: "system", author: "system", runStatus: "completed" }),
    ).rejects.toThrow("run_status");
    await expect(
      appendRoomEvent({ ...base, kind: "run_started", authorKind: "system", author: "system", runStatus: "running", failureKind: "ambiguous" }),
    ).rejects.toThrow("failure_kind");
    // run_finished requires completed|failed|timed_out; failure_kind only for failed
    await expect(
      appendRoomEvent({ ...base, kind: "run_finished", authorKind: "system", author: "system" }),
    ).rejects.toThrow("run_status");
    await expect(
      appendRoomEvent({ ...base, kind: "run_finished", authorKind: "system", author: "system", runStatus: "running" }),
    ).rejects.toThrow("run_status");
    await expect(
      appendRoomEvent({ ...base, kind: "run_finished", authorKind: "system", author: "system", runStatus: "completed", failureKind: "ambiguous" }),
    ).rejects.toThrow("failure_kind");
    await expect(
      appendRoomEvent({ ...base, kind: "run_finished", authorKind: "system", author: "system", runStatus: "failed", failureKind: "bogus" as never }),
    ).rejects.toThrow("failure_kind");
    // run_cancelled requires cancelled and no failure_kind
    await expect(
      appendRoomEvent({ ...base, kind: "run_cancelled", authorKind: "system", author: "system" }),
    ).rejects.toThrow("run_status");
    await expect(
      appendRoomEvent({ ...base, kind: "run_cancelled", authorKind: "system", author: "system", runStatus: "cancelled", failureKind: "launch_failure" }),
    ).rejects.toThrow("failure_kind");

    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, "collaboration", "rooms", roomId, "events"))).resolves.toEqual([]);
  });
});

describe("listRoomEvents durable reader", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-rooms-reader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedRoom(): Promise<string> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Reader room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const steward = await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: "Go.",
      addressedAgent: "kimi",
      now: () => new Date("2026-08-02T14:01:00.000Z"),
      nonce: () => "a1",
    });
    await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "run_started",
      authorKind: "system",
      author: "system",
      body: "Run started.",
      runStatus: "running",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:02:00.000Z"),
      nonce: () => "a2",
    });
    await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "agent_message",
      authorKind: "agent",
      author: "kimi",
      body: "Done here.",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:03:00.000Z"),
      nonce: () => "a3",
    });
    await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "run_finished",
      authorKind: "system",
      author: "system",
      body: "Run completed.",
      runStatus: "completed",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:04:00.000Z"),
      nonce: () => "a4",
    });
    return room.id;
  }

  it("returns validated chronological event records with bodies, optional fields, and vault-relative paths", async () => {
    const roomId = await seedRoom();
    const events = await listRoomEvents({ vaultRoot: root, roomId });

    expect(events.map((event) => event.kind)).toEqual(["steward_message", "run_started", "agent_message", "run_finished"]);
    const [steward, started, reply, finished] = events;
    expect(steward?.addressedAgent).toBe("kimi");
    expect(steward?.correlationId).toBeUndefined();
    expect(steward?.body).toBe("Go.");
    expect(steward?.path).toBe(`collaboration/rooms/${roomId}/events/${steward?.id ?? "missing"}.md`);
    expect(steward?.path.startsWith("/")).toBe(false);
    expect(started?.runStatus).toBe("running");
    expect(started?.correlationId).toBe(steward?.id ?? "missing");
    expect(reply?.author).toBe("kimi");
    expect(reply?.body).toBe("Done here.");
    expect(finished?.runStatus).toBe("completed");
    expect(finished?.failureKind).toBeUndefined();
  });

  it("rejects a missing room and an invalid room id before any vault access", async () => {
    await expect(listRoomEvents({ vaultRoot: root, roomId: "no-such-room" })).rejects.toThrow("no-such-room");
    await expect(listRoomEvents({ vaultRoot: root, roomId: "../escape" })).rejects.toThrow("Invalid room id");
  });

  it("fails closed on a tampered event naming its vault-relative path", async () => {
    const roomId = await seedRoom();
    const eventsDir = join(root, "collaboration", "rooms", roomId, "events");
    const names = await (await import("node:fs/promises")).readdir(eventsDir);
    const target = names.find((name) => name.includes("agent-message"))!;
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(join(eventsDir, target), "utf8");
    // Tamper: author_kind no longer matches the kind vocabulary.
    await writeFile(join(eventsDir, target), original.replace("author_kind: agent", "author_kind: system"), "utf8");

    await expect(listRoomEvents({ vaultRoot: root, roomId })).rejects.toThrow(
      `collaboration/rooms/${roomId}/events/${target}`,
    );
  });

  it("fails closed when an event filename does not match its frontmatter id", async () => {
    const roomId = await seedRoom();
    const eventsDir = join(root, "collaboration", "rooms", roomId, "events");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(eventsDir, "forged-name.md"),
      [
        "---",
        "type: Room Event",
        "id: some-other-id",
        `room: ${roomId}`,
        "created: 2026-08-02T14:05:00.000Z",
        "author_kind: steward",
        "author: steward",
        "kind: steward_message",
        "---",
        "",
        "Forged.",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(listRoomEvents({ vaultRoot: root, roomId })).rejects.toThrow("forged-name.md");
  });

  it("skips dotfiles and non-Markdown files in the events directory", async () => {
    const roomId = await seedRoom();
    const eventsDir = join(root, "collaboration", "rooms", roomId, "events");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(eventsDir, ".hidden.md"), "secret", "utf8");
    await writeFile(join(eventsDir, "notes.txt"), "not an event", "utf8");

    const events = await listRoomEvents({ vaultRoot: root, roomId });
    expect(events).toHaveLength(4);
  });
});

describe("listRoomEvents correlation integrity", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-rooms-corr-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedCorrelated(): Promise<{ roomId: string; stewardId: string }> {
    const room = await createRoom({
      vaultRoot: root,
      title: "Correlation room",
      participants: ["kimi"],
      now: () => new Date("2026-08-02T14:00:00.000Z"),
    });
    const steward = await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: "Go.",
      addressedAgent: "kimi",
      now: () => new Date("2026-08-02T14:01:00.000Z"),
      nonce: () => "c1",
    });
    await appendRoomEvent({
      vaultRoot: root,
      roomId: room.id,
      kind: "agent_message",
      authorKind: "agent",
      author: "kimi",
      body: "Reply.",
      correlationId: steward.id,
      now: () => new Date("2026-08-02T14:02:00.000Z"),
      nonce: () => "c2",
    });
    return { roomId: room.id, stewardId: steward.id };
  }

  it("fails closed when a correlation_id names no event in the same room", async () => {
    const { roomId } = await seedCorrelated();
    const eventsDir = join(root, "collaboration", "rooms", roomId, "events");
    const names = await (await import("node:fs/promises")).readdir(eventsDir);
    const target = names.find((name) => name.includes("agent-message"))!;
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(join(eventsDir, target), "utf8");
    await writeFile(
      join(eventsDir, target),
      original.replace(/correlation_id: .+/, "correlation_id: 20260802T130000000Z-steward-message-ghost"),
      "utf8",
    );

    await expect(listRoomEvents({ vaultRoot: root, roomId })).rejects.toThrow(
      `collaboration/rooms/${roomId}/events/${target}`,
    );
  });

  it("fails closed when an event correlates to itself", async () => {
    const { roomId } = await seedCorrelated();
    const eventsDir = join(root, "collaboration", "rooms", roomId, "events");
    const names = await (await import("node:fs/promises")).readdir(eventsDir);
    const target = names.find((name) => name.includes("agent-message"))!;
    const selfId = target.replace(/\.md$/, "");
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(join(eventsDir, target), "utf8");
    await writeFile(join(eventsDir, target), original.replace(/correlation_id: .+/, `correlation_id: ${selfId}`), "utf8");

    await expect(listRoomEvents({ vaultRoot: root, roomId })).rejects.toThrow(
      `collaboration/rooms/${roomId}/events/${target}`,
    );
  });
});
