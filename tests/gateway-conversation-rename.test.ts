import { mkdtemp, readdir, readFile, rename as renameDir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversation, readConversationEvents } from "../src/conversations.js";

/**
 * U2 — authenticated gateway HTTP surface for the accepted durable rename
 * core (contract `conversation-details-rename-contract.md` §Gateway/API):
 * POST /api/conversations/<id>/rename with `{title}`. The route only calls
 * the rename core and maps its typed result to the bounded vocabulary:
 * 200 {conversation, renamed:true, event(previousTitle,title)} | 200
 * {conversation, renamed:false}; 400 invalid/missing title; 401; 404
 * absent/unwired/malformed id; 409 exact lock-busy; 500 bounded
 * event-append residual (manifest authoritative). State-only: no dispatch/
 * abort/attach/SSE/broker/Pi/session/membership side effect; no raw error/
 * path/lock/Pi leakage.
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

describe("Gateway Conversation rename route (U2)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-rename-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-rename-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    if (server !== undefined && server !== null) {
      await server.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: { withConversations?: boolean }): Promise<void> {
    const withConversations = options?.withConversations ?? true;
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      ...(withConversations
        ? {
            vaultRoot: root,
            runnableAgents: ["fake"],
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

  async function rename(conversationId: string, title: string): Promise<Response> {
    return post(url(`/api/conversations/${encodeURIComponent(conversationId)}/rename`), { title }, token);
  }

  describe("authenticated renames", () => {
    it("renames: 200 safe conversation, renamed:true, event carries previous/new bounded titles; response is not fabricated", async () => {
      await startServer();
      const id = await createConversationViaApi("Rename me");
      const titleBefore = (await readConversation({ vaultRoot: root, conversationId: id })).title;

      const response = await rename(id, "  Ship notes  ");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        conversation: { id: string; title: string; status: string; created: string; audience: string[]; updated: string; path: string };
        renamed: boolean;
        event: { id: string; conversationId: string; kind: string; created: string; previousTitle: string; title: string };
      };
      expect(body.renamed).toBe(true);
      expect(body.conversation.id).toBe(id);
      expect(body.conversation.title).toBe("Ship notes");
      expect(body.event.kind).toBe("conversation_renamed");
      expect(body.event.conversationId).toBe(id);
      expect(body.event.previousTitle).toBe(titleBefore);
      expect(body.event.title).toBe("Ship notes");
      // Safe shapes only: vault-relative path, no absolute paths, no internal
      // typed-result names, no byte counts, no lock content.
      expect(body.conversation.path).not.toContain(root);
      expect(JSON.stringify(body)).not.toMatch(/event-append-failed|lock-busy|bytes|absolutePath|acquiredAt|token/i);

      // Durable truth: the manifest really renamed and one event exists.
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.title).toBe("Ship notes");
      expect(reread.created).toBe(body.conversation.created);
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "conversation_renamed"]);
      expect(events[1]?.authorKind).toBe("steward");
      expect(events[1]?.previousTitle).toBe(titleBefore);
      expect(events[1]?.title).toBe("Ship notes");
    });

    it("same normalized title: 200 renamed:false, no event key, byte-identical manifest and events", async () => {
      await startServer();
      const id = await createConversationViaApi("Repeat rename");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventFilesBefore = await readdir(eventsDir(id));
      const title = (await readConversation({ vaultRoot: root, conversationId: id })).title;

      const repeat = await rename(id, `  ${title}  `);
      expect(repeat.status).toBe(200);
      const body = (await repeat.json()) as { renamed: boolean; event?: unknown };
      expect(body.renamed).toBe(false);
      expect("event" in body).toBe(false);
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventFilesBefore);
    });

    it("unknown rename subpaths and GET remain 404", async () => {
      await startServer();
      const id = await createConversationViaApi("Strict dispatch");
      expect((await fetch(url(`/api/conversations/${id}/rename`), { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(url(`/api/conversations/${id}/rename/x`), { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await rename(id, "Fine title")).status).toBe(200);
    });
  });

  describe("bounded 400 validation (no mutation)", () => {
    it("missing, non-string, empty, control/newline, and overlength titles are 400 with non-secret messages", async () => {
      await startServer();
      const id = await createConversationViaApi("Validation");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventFilesBefore = await readdir(eventsDir(id));

      for (const title of ["", "   ", 42, "line one\nline two", "tab\there", "x".repeat(121)] as unknown[]) {
        const response = await post(url(`/api/conversations/${id}/rename`), { title }, token);
        expect(response.status, String(title)).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error).not.toMatch(/\n|absolutePath|token|: |\bE[A-Z]{2,}\b/i);
        expect(body.error.length).toBeLessThan(200);
      }
      // A missing title field is a bounded 400 too.
      const missing = await post(url(`/api/conversations/${id}/rename`), {}, token);
      expect(missing.status).toBe(400);
      // No durable mutation from any invalid request.
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventFilesBefore);
    });
  });

  describe("auth, capability, absence, and malformed ids", () => {
    it("unauthenticated rename is 401 with byte-identical durable state", async () => {
      await startServer();
      const id = await createConversationViaApi("Auth gate");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventsBefore = await readdir(eventsDir(id));
      const titleBefore = (await readConversation({ vaultRoot: root, conversationId: id })).title;

      const response = await post(url(`/api/conversations/${id}/rename`), { title: "Nope" });
      expect(response.status).toBe(401);
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventsBefore);
      expect((await readConversation({ vaultRoot: root, conversationId: id })).title).toBe(titleBefore);
    });

    it("unwired capability: 404 not found and no mutation", async () => {
      await startServer({ withConversations: false });
      const response = await rename("20260806T000000000Z-x", "New");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("not found");
    });

    it("absent conversation: 404 conversation not found (never mislabelled as contention) and no mutation", async () => {
      await startServer();
      const missing = "20260806T000000000Z-absent";
      const response = await rename(missing, "New");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("conversation not found");
      await expect(stat(join(root, "collaboration", "conversations", missing))).rejects.toThrow();
    });

    it("malformed conversation id keeps the existing family 404 behavior", async () => {
      await startServer();
      const response = await rename("Not Valid!", "New");
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/Invalid conversation id/i);
    });
  });

  describe("genuine lock contention (exact 409, no side effects)", () => {
    it("a pre-held .audience.lock yields the exact 409 vocabulary with no manifest/event side effect", async () => {
      await startServer();
      const id = await createConversationViaApi("Locked rename");
      const manifestBefore = await readFile(manifestPath(id), "utf8");
      const eventsBefore = await readdir(eventsDir(id));
      await writeFile(
        lockPath(id),
        JSON.stringify({ token: "held", pid: 0, conversationId: id, acquiredAt: "2026-08-05T00:00:00.000Z" }),
        { flag: "wx" },
      );

      const response = await rename(id, "Busy rename");
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe(`Conversation '${id}' is busy (another update holds the lock); retry after it completes.`);
      expect(await readFile(manifestPath(id), "utf8")).toBe(manifestBefore);
      expect(await readdir(eventsDir(id))).toEqual(eventsBefore);
    });
  });

  describe("event-append failure boundary (bounded 500, manifest authoritative)", () => {
    it("forced event-append failure: 500 internal error only; manifest renamed; no fake/rolled-back event", async () => {
      await startServer();
      const id = await createConversationViaApi("Append fail");
      const eventsBackup = join(root, "events-backup");
      await renameDir(eventsDir(id), eventsBackup);
      await writeFile(eventsDir(id), "not a directory", "utf8");

      const response = await rename(id, "Renamed despite failure");
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("internal error");
      expect(JSON.stringify(body)).not.toMatch(/ENOTDIR|EACCES|event-append-failed|disk full/i);

      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.title).toBe("Renamed despite failure");

      await rm(eventsDir(id), { force: true });
      await renameDir(eventsBackup, eventsDir(id));
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message"]);
    });
  });

  describe("side-effect and safety proofs", () => {
    it("rename routes are state-only: no dispatch/abort/attach/SSE/new session, JSON bounded responses", async () => {
      await startServer();
      const id = await createConversationViaApi("Side-effect proof");
      const response = await rename(id, "Quiet rename");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      // No run events (no dispatch/Pi spawn), no session files created.
      const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
      expect(events.map((e) => e.kind)).toEqual(["steward_message", "conversation_renamed"]);
      const sessionsDir = join(root, "team", "piren", "sessions");
      expect(await readdir(sessionsDir)).toEqual([]);
      expect((await response.text()).trim().startsWith("{")).toBe(true);
    });

    it("a rename never changes membership, status, or the conversation id", async () => {
      await startServer();
      const id = await createConversationViaApi("Membership proof @fake");
      const response = await rename(id, "Renamed");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { conversation: { id: string; status: string; audience: string[]; createdBy: string } };
      expect(body.conversation.id).toBe(id);
      expect(body.conversation.status).toBe("open");
      expect(body.conversation.audience).toEqual(["fake"]);
      const reread = await readConversation({ vaultRoot: root, conversationId: id });
      expect(reread.audience).toEqual(["fake"]);
      expect(reread.createdBy).toBe("steward");
    });
  });
});
