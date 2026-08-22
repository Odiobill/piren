import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

async function post(url: string, body: unknown, token?: string, raw?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

/**
 * P3.2 (workbench-ux-follow-up-design §1.4; accepted P2/P3.1) — authenticated
 * POST /api/conversations/start-peer: strict {peers} parsing; whole-audience
 * fail-before-persist validation against the gateway-resolved runnable set;
 * one atomic manifest with the canonical initial audience and immutable
 * cardinal title; one canonical system origin after the manifest, published
 * verbatim to scoped SSE; HTTP 201 {conversation, event} with NO dispatch
 * field; zero broker contact/greeting/queue activity. The single-agent route
 * is untouched (its suite must pass unmodified).
 */
describe("POST /api/conversations/start-peer (P3.2)", () => {
  let root: string;
  let server: GatewayServer | undefined;
  let handle: GatewayHandle;
  const token = "test-peer-start-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-peer-start-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    if (server !== undefined) await server.close();
    server = undefined;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(options?: {
    withConversations?: boolean;
    runnableAgents?: string[];
    vaultAgents?: string[];
    targetBuilder?: (agent: string) => Promise<ReturnType<typeof fakePiTarget>>;
  }): Promise<void> {
    const withConversations = options?.withConversations ?? true;
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      ...(withConversations
        ? {
            vaultRoot: root,
            runnableAgents: options?.runnableAgents ?? ["dipu", "kimi", "zora"],
            vaultAgents: options?.vaultAgents ?? ["dipu", "kimi", "zora"],
            targetBuilder: options?.targetBuilder ?? (async () => fakePiTarget()),
          }
        : {}),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function persistedConversationCount(): Promise<number> {
    try {
      return (await readdir(join(root, "collaboration", "conversations"))).length;
    } catch {
      return 0;
    }
  }

  it("requires Bearer auth and the conversation capability", async () => {
    await startServer({ withConversations: false });
    const capabilityMissing = await post(url("/api/conversations/start-peer"), { peers: ["dipu", "kimi"] }, token);
    expect(capabilityMissing.status).toBe(404);

    await startServer({ withConversations: true });
    const noAuth = await post(url("/api/conversations/start-peer"), { peers: ["dipu", "kimi"] });
    expect(noAuth.status).toBe(401);
  });

  it("rejects malformed/extra/envelope violations with 400 and zero persistence", async () => {
    await startServer();
    const cases: Array<{ raw?: string; body?: unknown }> = [
      { raw: "not json" },
      { body: {} },
      { body: { agent: "dipu" } },
      { body: { peers: "dipu" } },
      { body: { peers: ["dipu", "kimi"], extra: 1 } },
      { body: [] },
    ];
    for (const entry of cases) {
      const response =
        entry.raw !== undefined
          ? await post(url("/api/conversations/start-peer"), undefined, token, entry.raw)
          : await post(url("/api/conversations/start-peer"), entry.body, token);
      expect(response.status, JSON.stringify(entry)).toBe(400);
    }
    expect(await persistedConversationCount()).toBe(0);
  });

  it("rejects cardinality outside 2-8 with 400 and zero persistence", async () => {
    await startServer();
    const one = await post(url("/api/conversations/start-peer"), { peers: ["dipu"] }, token);
    expect(one.status).toBe(400);
    const nine = await post(url("/api/conversations/start-peer"), { peers: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }, token);
    expect(nine.status).toBe(400);
    expect(await persistedConversationCount()).toBe(0);
  });

  it("rejects blank, grammar-invalid, duplicate, and non-string members with 400 and zero persistence", async () => {
    await startServer();
    const cases: unknown[] = [
      { peers: ["dipu", "   "] },
      { peers: ["dipu", "Bad_Name"] },
      { peers: ["dipu", "kimi", "dipu"] },
      { peers: ["dipu", 42] },
      { peers: ["dipu", { toString() { throw new Error("never coerced"); } }] },
    ];
    for (const body of cases) {
      const response = await post(url("/api/conversations/start-peer"), body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).not.toContain(root);
    }
    expect(await persistedConversationCount()).toBe(0);
  });

  it("rejects any member outside the gateway-resolved runnable set with 400 and zero persistence", async () => {
    await startServer({ runnableAgents: ["dipu", "kimi"], vaultAgents: ["dipu", "kimi", "zora"] });
    const cases: unknown[] = [
      { peers: ["dipu", "nobody"] },
      { peers: ["dipu", "zora"] },
      { peers: ["dipu", "Dipu"] },
    ];
    for (const body of cases) {
      const response = await post(url("/api/conversations/start-peer"), body, token);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await persistedConversationCount()).toBe(0);
  });

  it("bounds and redacts validation errors: raw long/secret-looking values never appear in responses (P3.2 correction)", async () => {
    await startServer();
    const longInvalid = "x".repeat(5000) + "-secret-looking-token-abcdef0123456789";
    const longValidNonRunnable = ("zora-".repeat(1000) + "end").toLowerCase();
    const cases: unknown[] = [
      { peers: ["dipu", longInvalid] },
      { peers: ["dipu", longValidNonRunnable] },
    ];
    for (const body of cases) {
      const response = await post(url("/api/conversations/start-peer"), body, token);
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).not.toContain(longInvalid);
      expect(payload.error).not.toContain(longValidNonRunnable);
      expect(payload.error).not.toContain("secret-looking-token");
      // Bounded: a bounded class summary, never an unbounded client echo.
      expect(payload.error.length).toBeLessThan(400);
    }
    expect(await persistedConversationCount()).toBe(0);
  });

  it("creates exactly one peer conversation: canonical audience, cardinal title, single system origin, 201 without dispatch, zero broker contact", async () => {
    // A missing-binary target builder proves zero broker contact: any dispatch
    // attempt would fail (launch_failure) or throw here.
    await startServer({
      targetBuilder: async () => {
        throw new Error("broker must never be contacted for peer creation");
      },
    });
    const response = await post(url("/api/conversations/start-peer"), { peers: ["kimi", "dipu"] }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      conversation: { id: string; title: string; audience: string[]; status: string };
      event: { id: string; kind: string };
      dispatch?: unknown;
    };
    expect(body.conversation.title).toBe("Conversation with 2 agents");
    expect(body.conversation.audience).toEqual(["dipu", "kimi"]);
    expect(body.conversation.status).toBe("open");
    expect(body.event.kind).toBe("conversation_start_requested");
    expect("dispatch" in body).toBe(false);

    // Durable evidence: exactly ONE event, the canonical system origin; no
    // run/greeting/queue evidence whatsoever.
    const events = await readConversationEvents({ vaultRoot: root, conversationId: body.conversation.id });
    expect(events.map((e) => e.kind)).toEqual(["conversation_start_requested"]);
    expect(events[0]?.authorKind).toBe("system");
    expect(events[0]?.author).toBe("system");
    expect(events[0]?.body).toBe("The steward requested starting this peer conversation with: dipu, kimi.");
  });

  it("persists the origin AFTER the manifest and publishes it BEFORE returning (structural pin, zero broker contact)", async () => {
    const source = await readFile(join(process.cwd(), "src", "gateway-http.ts"), "utf8");
    const handlerStart = source.indexOf("private async handleConversationStartPeer");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = source.indexOf("private async handle", handlerStart + 1);
    const handler = source.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
    const appendIndex = handler.indexOf('kind: "conversation_start_requested"');
    const publishIndex = handler.indexOf("publishConversationEvent");
    expect(appendIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(appendIndex);
    // No broker DISPATCH path exists anywhere in the peer handler (the
    // broker is referenced only for verbatim SSE publication of the
    // committed origin record — contained observability, never dispatch).
    expect(handler).not.toContain("startConversationAgentRun");
  });
});
