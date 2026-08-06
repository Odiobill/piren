import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";
import { checkActiveGate, formatActiveGateRejection } from "../src/conversation-contract.js";

/**
 * C3-A: authenticated POST /api/conversations/<id>/attach (stateless gateway
 * attach gate). The route reads the durable Conversation manifest and applies
 * the accepted C1 `checkActiveGate` against the gateway's resolved runnable
 * agents. It is STATELESS: no vault write, membership update, broker
 * dispatch, Pi client/session creation, live subscription, queue, retry, or
 * persistent active-conversation state.
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

describe("Gateway Conversation attach gate (C3-A)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-attach-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-attach-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    if (server !== undefined && server !== null) {
      await server.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: { runnableAgents?: string[] }): Promise<void> {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: options?.runnableAgents ?? ["fake"],
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversationViaApi(text: string): Promise<{ id: string }> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    return { id: body.conversation?.id ?? "" };
  }

  it("rejects unauthenticated attach with 401", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Hello @fake");
    const response = await post(url(`/api/conversations/${id}/attach`), {});
    expect(response.status).toBe(401);
  });

  it("returns 404 for an absent conversation", async () => {
    await startServer();
    const response = await post(url("/api/conversations/20260806T000000000Z-missing/attach"), {}, token);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it("attaches (200) when every durable audience member is locally runnable", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Please review @fake");
    const response = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attached: boolean;
      conversation: { id: string; audience: string[] };
      gate: { ok: boolean; missing: string[]; malformed: string[] };
    };
    expect(body.attached).toBe(true);
    expect(body.conversation.id).toBe(id);
    expect(body.conversation.audience).toEqual(["fake"]);
    expect(body.gate).toEqual({ ok: true, missing: [], malformed: [] });
  });

  it("attaches (200) a zero-mention conversation with an empty durable audience", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Context only, no members");
    const response = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attached: boolean; gate: { ok: boolean } };
    expect(body.attached).toBe(true);
    expect(body.gate.ok).toBe(true);
  });

  it("rejects attach with a non-secret 409 when a durable audience member is not locally runnable", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Hello @fake");
    // Make a durable member non-runnable on THIS gateway by hand-writing the
    // durable audience to reference an agent outside the local runnable set
    // (the audience itself is durable and never changes; the manifest stays
    // syntactically valid so the strict parser accepts it).
    const manifestPath = join(root, "collaboration", "conversations", id, "index.md");
    const current = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, current.replace("audience:\n  - fake", "audience:\n  - ghost"), "utf8");

    const response = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      gate: { ok: boolean; missing: string[]; malformed: string[] };
    };
    expect(body.error).toMatch(/not locally runnable/i);
    expect(body.error).toContain("ghost");
    // Non-secret vocabulary: the rejection never names local config paths,
    // tokens, or machine details.
    expect(body.error).not.toMatch(/config|token|secret/i);
    expect(body.gate).toEqual({ ok: false, missing: ["ghost"], malformed: [] });
  });

  it("the pure C1 gate rejects a malformed durable audience member (non-secret 409 message)", () => {
    // Route-level malformed members cannot be produced through the strict
    // manifest parser (it enforces the same agent-name pattern the C1 gate
    // checks), so the malformed branch is pinned at its reachable seam: the
    // C1 gate predicate plus the deterministic rejection message builder.
    const gate = checkActiveGate(["fake", "Bad Name!"], ["fake"]);
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual([]);
    expect(gate.malformed).toEqual(["Bad Name!"]);
    const message = formatActiveGateRejection("conv-1", gate);
    expect(message).toMatch(/conv-1/);
    expect(message).toMatch(/malformed/i);
    expect(message).toContain("Bad Name!");
    expect(message).toMatch(/read-only/i);
  });

  it("attach is stateless: a 200 changes no vault state and causes no dispatch", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Attach me @fake");
    const manifestPath = join(root, "collaboration", "conversations", id, "index.md");
    const manifestBefore = await readFile(manifestPath, "utf8");
    const eventsBefore = await readConversationEvents({ vaultRoot: root, conversationId: id });

    const response = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attached: boolean; gate: { ok: boolean } };
    expect(body.attached).toBe(true);
    expect(body.gate.ok).toBe(true);
    // The stateless response carries no event, dispatch, stream, or session fields.
    expect("event" in body).toBe(false);
    expect("dispatch" in body).toBe(false);
    expect("stream" in body).toBe(false);

    // Manifest byte-for-byte unchanged; event records unchanged (attach adds
    // no run_started/run_finished events of its own — the create's dispatch
    // already happened and its events are part of the baseline); no audience
    // lock was created.
    const manifestAfter = await readFile(manifestPath, "utf8");
    expect(manifestAfter).toBe(manifestBefore);
    const eventsAfter = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(eventsAfter).toEqual(eventsBefore);
    const runCountBefore = eventsBefore.filter((e) => e.kind === "run_started").length;
    expect(eventsAfter.filter((e) => e.kind === "run_started")).toHaveLength(runCountBefore);
    await expect(stat(join(root, "collaboration", "conversations", id, ".audience.lock"))).rejects.toThrow();
    const eventFilenames = await readdir(join(root, "collaboration", "conversations", id, "events"));
    expect(eventFilenames).toHaveLength(eventsBefore.length);
  });

  it("attach is stateless: a rejected 409 also changes no vault state and causes no dispatch", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Context only");
    // No members -> openable; now make the member list un-runnable by
    // hand-writing a manifest whose audience references a non-runnable agent
    // (still syntactically valid, so the manifest parser accepts it).
    const manifestPath = join(root, "collaboration", "conversations", id, "index.md");
    const current = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, current.replace("audience: []", "audience:\n  - ghost"), "utf8");

    const manifestBefore = await readFile(manifestPath, "utf8");
    const eventsBefore = await readConversationEvents({ vaultRoot: root, conversationId: id });

    const response = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { gate: { ok: boolean; missing: string[] } };
    expect(body.gate.ok).toBe(false);
    expect(body.gate.missing).toEqual(["ghost"]);

    const manifestAfter = await readFile(manifestPath, "utf8");
    expect(manifestAfter).toBe(manifestBefore);
    const eventsAfter = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(eventsAfter).toEqual(eventsBefore);
    await expect(stat(join(root, "collaboration", "conversations", id, ".audience.lock"))).rejects.toThrow();
  });

  it("attach never opens a live stream: no stream subscription side effect exists", async () => {
    await startServer({ runnableAgents: ["fake"] });
    const { id } = await createConversationViaApi("Attach @fake");
    // A stream subscription would keep the HTTP connection open; attach must
    // return a bounded JSON response that ends promptly (the fetch above
    // already proves it resolves; this pins the response is a plain JSON body).
    const response = await post(url(`/api/conversations/${id}/attach`), {}, token);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text).toContain('"attached":true');
  });
});
