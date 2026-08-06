import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversation, readConversationEvents } from "../src/conversations.js";

/**
 * L2 — authenticated gateway HTTP surface for the accepted L1 archive/reopen
 * durable core (contract §3/§9 L2; selected defaults). Exactly two routes:
 * POST /api/conversations/<id>/archive and .../reopen. The routes only call
 * the L1 transitionConversationLifecycle and map its typed result to the
 * bounded HTTP vocabulary: 200 transitioned:true|false (+event only when
 * true), 409 exact lock-busy, 404 absent/unwired, 500 bounded for
 * event-append failure. State-only: no dispatch/abort/attach/SSE/broker/Pi/
 * session/membership side effects.
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("Gateway Conversation lifecycle routes (L2)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-lifecycle-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-lifecycle-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    if (server !== undefined && server !== null) {
      await server.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: { withConversations?: boolean; runnableAgents?: string[] }): Promise<void> {
    const withConversations = options?.withConversations ?? true;
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      ...(withConversations
        ? {
            vaultRoot: root,
            runnableAgents: options?.runnableAgents ?? ["fake"],
            targetBuilder: async () => fakePiTarget(),
          }
        : {}),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversationViaApi(text: string): Promise<string> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    const id = body.conversation?.id ?? "";
    if (id === "") throw new Error("create failed in setup");
    return id;
  }

  function manifestPath(conversationId: string): string {
    return join(root, "collaboration", "conversations", conversationId, "index.md");
  }

  function lockPath(conversationId: string): string {
    return join(root, "collaboration", "conversations", conversationId, ".audience.lock");
  }

  function eventsDir(conversationId: string): string {
    return join(root, "collaboration", "conversations", conversationId, "events");
  }

  async function lifecycle(conversationId: string, transition: "archive" | "reopen"): Promise<Response> {
    return post(url(`/api/conversations/${encodeURIComponent(conversationId)}/${transition}`), {}, token);
  }

  describe("authenticated transitions", () => {
    it("archives: 200 safe archived manifest, transitioned:true, one lifecycle_transition event; response is not fabricated", async () => {
      await startServer();
      const id = await createConversationViaApi("Archive me");
      const before = await readFile(manifestPath(id), "utf8");

      const response = await lifecycle(id, "archive");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        conversation: { id: string; status: string; created: string; audience: string[]; updated: string; path: string };
        transitioned: boolean;
        event: { id: string; conversationId: string; kind: string; created: string };
      };
      expect(body.transitioned).toBe(true);
      expect(body.conversation.id).toBe(id);
      expect(body.conversation.status).toBe("archived");
      expect(body.conversation.audience).toEqual([]);
      expect(body.event.kind).toBe("lifecycle_transition");
      expect(body.event.conversationId).toBe(id);
      // Safe shapes only: vault-relative path, no absolute paths, no internal
      // typed-result names, no byte counts, no lock content.
      expect(body.conversation.path).not.toContain(root);
      expect(JSON.stringify(body)).not.toMatch(/event-append-failed|lock-busy|bytes|absolutePath|acquiredAt|token/i);

      // Durable truth: the manifest really transitioned and one event exists
      // (the response was not fabricated).
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.status).toBe("archived");
      const createdBefore = before.match(/created: (\S+)/)?.[1];
      expect(reread.created).toBe(createdBefore);
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "lifecycle_transition"]);
      expect(events[1]?.authorKind).toBe("steward");
      expect(events[1]?.lifecycleState).toBe("archived");
    });

    it("reopens: 200 safe open manifest, transitioned:true, lifecycle_transition event with lifecycleState open", async () => {
      await startServer();
      const id = await createConversationViaApi("Reopen me");
      expect((await lifecycle(id, "archive")).status).toBe(200);

      const response = await lifecycle(id, "reopen");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { transitioned: boolean; conversation: { status: string }; event: { kind: string } };
      expect(body.transitioned).toBe(true);
      expect(body.conversation.status).toBe("open");
      expect(body.event.kind).toBe("lifecycle_transition");
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "lifecycle_transition", "lifecycle_transition"]);
      expect(events[2]?.lifecycleState).toBe("open");
      expect(events[2]?.body).toBe("Reopened by steward.");
    });

    it("unknown lifecycle verbs and subpaths remain 404", async () => {
      await startServer();
      const id = await createConversationViaApi("Strict dispatch");
      for (const path of [
        `/api/conversations/${id}/freeze`,
        `/api/conversations/${id}/archive/x`,
        `/api/conversations/${id}/reopen/x`,
      ]) {
        const response = await fetch(url(path), { method: "POST", headers: { authorization: `Bearer ${token}` } });
        expect(response.status, path).toBe(404);
      }
      expect((await lifecycle(id, "archive")).status).toBe(200);
    });
  });

  describe("idempotent same-target repeats (selected default)", () => {
    it("archiving an archived conversation: 200 transitioned:false, no event key, byte-identical manifest and events", async () => {
      await startServer();
      const id = await createConversationViaApi("Repeat archive");
      expect((await lifecycle(id, "archive")).status).toBe(200);
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventFilesBefore = await readdir(eventsDir(id));

      const repeat = await lifecycle(id, "archive");
      expect(repeat.status).toBe(200);
      const body = (await repeat.json()) as { transitioned: boolean; event?: unknown };
      expect(body.transitioned).toBe(false);
      expect("event" in body).toBe(false);
      // No hidden write: manifest bytes and event files byte-identical.
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventFilesBefore);
    });

    it("reopening an open conversation: 200 transitioned:false, no event, no write", async () => {
      await startServer();
      const id = await createConversationViaApi("Repeat reopen");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const repeat = await lifecycle(id, "reopen");
      expect(repeat.status).toBe(200);
      const body = (await repeat.json()) as { transitioned: boolean };
      expect(body.transitioned).toBe(false);
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readConversationEvents({ vaultRoot: root, conversationId: id })).toHaveLength(1);
    });
  });

  describe("auth, capability, absence, and malformed ids", () => {
    it("unauthenticated archive is 401 with byte-identical durable state", async () => {
      await startServer();
      const id = await createConversationViaApi("Auth gate");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventsBefore = await readdir(eventsDir(id));

      const response = await fetch(url(`/api/conversations/${id}/archive`), { method: "POST", body: "{}" });
      expect(response.status).toBe(401);
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventsBefore);
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.status).toBe("open");
    });

    it("unwired capability: 404 not found and no mutation", async () => {
      await startServer({ withConversations: false });
      const response = await post(url("/api/conversations/20260806T000000000Z-x/archive"), {}, token);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("not found");
    });

    it("absent conversation: 404 conversation not found (never mislabelled as contention) and no mutation", async () => {
      await startServer();
      const missing = "20260806T000000000Z-absent";
      const response = await lifecycle(missing, "archive");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("conversation not found");
      await expect(stat(join(root, "collaboration", "conversations", missing))).rejects.toThrow();
    });

    it("malformed conversation id keeps the existing family 404 behavior", async () => {
      await startServer();
      const response = await lifecycle("Not Valid!", "archive");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/Invalid conversation id/i);
    });
  });

  describe("genuine lock contention (exact 409, no side effects)", () => {
    it("a pre-held .audience.lock yields the exact 409 vocabulary with no manifest/event side effect", async () => {
      await startServer();
      const id = await createConversationViaApi("Locked archive");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventsBefore = await readdir(eventsDir(id));
      await writeFile(
        lockPath(id),
        JSON.stringify({ token: "held", pid: 0, conversationId: id, acquiredAt: "2026-08-05T00:00:00.000Z" }),
        { flag: "wx" },
      );

      const response = await lifecycle(id, "archive");
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe(`Conversation '${id}' is busy (another update holds the lock); retry after it completes.`);
      // No manifest write, no event, no broker/Pi side effect (no run events).
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventsBefore);
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.status).toBe("open");
    });
  });

  describe("event-append failure boundary (bounded 500, manifest authoritative)", () => {
    it("forced event-append failure: 500 internal error only; manifest transitioned; no fake/rolled-back event", async () => {
      await startServer();
      const id = await createConversationViaApi("Append fail");
      // Deterministically break event append: move the events DIRECTORY aside
      // and replace it with a regular FILE, so readdir(eventsDir) inside the
      // append fails (ENOTDIR) AFTER the manifest rewrite succeeded. No sleeps,
      // no permissions games; the original events survive for restoration.
      const eventsBackup = join(root, "events-backup");
      await rename(eventsDir(id), eventsBackup);
      await writeFile(eventsDir(id), "not a directory", "utf8");

      const response = await lifecycle(id, "archive");
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("internal error");
      // No raw filesystem/typed-error leakage in the bounded 500.
      expect(JSON.stringify(body)).not.toMatch(/ENOTDIR|EACCES|event-append-failed|disk full/i);

      // The transitioned manifest is authoritative (no rollback).
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.status).toBe("archived");

      // Restore the original events dir: the failed append fabricated NO
      // lifecycle event (only the original steward_message survives).
      await rm(eventsDir(id), { force: true });
      await rename(eventsBackup, eventsDir(id));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message"]);
    });
  });

  describe("controlled concurrency and side-effect proofs", () => {
    it("concurrent archive vs reopen: exactly one 200 transitioned:true, one 409 busy, one event, no torn manifest", async () => {
      await startServer();
      const id = await createConversationViaApi("Concurrent race");
      const [archive, reopen] = await Promise.all([lifecycle(id, "archive"), lifecycle(id, "reopen")]);
      const statuses = [archive.status, reopen.status].sort();
      expect(statuses).toEqual([200, 409]);
      const okBody = (await (archive.status === 200 ? archive : reopen).json()) as { transitioned: boolean };
      expect(okBody.transitioned).toBe(true);
      const busyBody = (await (archive.status === 409 ? archive : reopen).json()) as { error: string };
      expect(busyBody.error).toMatch(/holds the lock/i);

      // Exactly one lifecycle event, consistent durable manifest (no torn/
      // last-writer-wins merge, no double dispatch).
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.filter((e) => e.kind === "lifecycle_transition")).toHaveLength(1);
      const raw = await readFile(manifestPath(id), "utf8");
      const statusLines = raw.split("\n").filter((line) => line.startsWith("status:"));
      expect(statusLines).toHaveLength(1);
      const final = await readConversation({ vaultRoot: root, conversationId: id });
      expect(["open", "archived"]).toContain(final.status);
      expect(final.created).toBeTruthy();
      expect(final.audience).toEqual([]);
    });

    it("archive vs message append: archived stays read-only/fail-closed with no dispatch and no audience change", async () => {
      await startServer();
      const id = await createConversationViaApi("Archive vs append");
      expect((await lifecycle(id, "archive")).status).toBe(200);

      // Message append to an archived conversation is the existing C2 409,
      // before any append/dispatch; no new run events are created.
      const append = await post(url(`/api/conversations/${id}/messages`), { text: "Hello @fake" }, token);
      expect(append.status).toBe(409);
      const appendBody = (await append.json()) as { error: string };
      expect(appendBody.error).toMatch(/is archived/i);
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "lifecycle_transition"]);
      expect(events.filter((e) => e.kind === "run_started")).toHaveLength(0);
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.audience).toEqual([]);
      expect(reread.status).toBe("archived");
    });

    it("lifecycle routes are state-only: no dispatch/abort/attach/SSE/new session, JSON bounded responses", async () => {
      await startServer();
      const id = await createConversationViaApi("Side-effect proof");
      const response = await lifecycle(id, "archive");
      expect(response.headers.get("content-type")).toContain("application/json");
      // No run events (no dispatch/Pi spawn), no attach side effect, no
      // session files created, no stream — the response ends as plain JSON.
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "lifecycle_transition"]);
      // No new session files were created by the lifecycle route (before/after
      // snapshot on the init scaffold's agent sessions dir).
      const sessionsDir = join(root, "team", "piren", "sessions");
      const sessionsBefore = await readdir(sessionsDir);
      expect(sessionsBefore).toEqual([]);
      expect((await response.text()).trim().startsWith("{")).toBe(true);
    });
  });

  describe("C2/C3-A regressions through the new routes", () => {
    it("archived conversations stay attach-rejected (read-only) and message fail-closed after archive", async () => {
      await startServer();
      const id = await createConversationViaApi("Regression @fake");
      expect((await lifecycle(id, "archive")).status).toBe(200);

      const attach = await post(url(`/api/conversations/${id}/attach`), {}, token);
      expect(attach.status).toBe(409);
      const attachBody = (await attach.json()) as { attached: boolean; error: string };
      expect(attachBody.attached).toBe(false);
      expect(attachBody.error).toMatch(/archived/i);

      const append = await post(url(`/api/conversations/${id}/messages`), { text: "nope @fake" }, token);
      expect(append.status).toBe(409);
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.filter((e) => e.kind === "steward_message")).toHaveLength(1);
    });

    it("after reopen, attach works again and a fresh message dispatches normally", async () => {
      await startServer();
      const id = await createConversationViaApi("Reopen regression @fake");
      expect((await lifecycle(id, "archive")).status).toBe(200);
      expect((await lifecycle(id, "reopen")).status).toBe(200);

      const attach = await post(url(`/api/conversations/${id}/attach`), {}, token);
      expect(attach.status).toBe(200);
      const append = await post(url(`/api/conversations/${id}/messages`), { text: "Go @fake" }, token);
      expect(append.status).toBe(200);
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual([
        "steward_message",
        "run_started",
        "agent_message",
        "run_finished",
        "lifecycle_transition",
        "lifecycle_transition",
        "steward_message",
        "run_started",
        "agent_message",
        "run_finished",
      ]);
    });
  });
});
