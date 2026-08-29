import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents, acquireConversationMutationLock } from "../src/conversations.js";
import { ConversationBroker } from "../src/conversation-broker.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

async function get(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(url, { headers });
}

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("Gateway Conversation workflow-budget routes (B4)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-budget-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-budget-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function startServer(runnableAgents: string[] = ["zai", "dipu"]): Promise<void> {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents,
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  }

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversation(text: string): Promise<string> {
    const response = await post(url("/api/conversations"), { text }, token);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { conversation: { id: string } };
    return body.conversation.id;
  }

  it("401 without a bearer token on all three routes", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    expect((await get(url(`/api/conversations/${conversationId}/agents/zai/workflow-status`))).status).toBe(401);
    expect((await get(url(`/api/conversations/${conversationId}/workflow-budgets`))).status).toBe(401);
    expect((await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: "x", edges: 10, expected_effective: { edges: 8, reworkRounds: 2 },
    })).status).toBe(401);
  });

  it("authenticated status route reports broker-derived facts (latest-run after settle)", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const response = await get(url(`/api/conversations/${conversationId}/agents/zai/workflow-status`), token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run_active: boolean;
      workflow: null | { root_event_id: string; association: string; base: { edges: number; reworkRounds: number }; effective: { edges: number; reworkRounds: number }; consumed: { edges: number }; worstPairOccurrences: number; low: boolean; exhausted: boolean; warnings: string[] };
    };
    expect(typeof body.run_active).toBe("boolean");
    expect(body.workflow).not.toBeNull();
    if (body.workflow !== null) {
      expect(body.workflow.association === "active-run" || body.workflow.association === "latest-run").toBe(true);
      expect(body.workflow.base).toEqual({ edges: 8, reworkRounds: 2 });
      expect(body.workflow.effective).toEqual({ edges: 8, reworkRounds: 2 });
      expect(body.workflow.consumed).toEqual({ edges: 0 });
      expect(body.workflow.warnings).toEqual([]);
    }
  });

  it("budgets route lists durable roots in sequence order with the association map", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const response = await get(url(`/api/conversations/${conversationId}/workflow-budgets`), token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      roots: Array<{ root_event_id: string; effective: { edges: number } }>;
      association: Record<string, { root_event_id: string; association: string } | null>;
    };
    expect(body.roots).toHaveLength(1);
    expect(body.roots[0]?.effective).toEqual({ edges: 8, reworkRounds: 2 });
    expect(body.association["zai"]).not.toBeNull();
  });

  it("CAS update happy path writes exactly one steward-authored budget event", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const response = await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: "whatever-the-route-resolves",
      edges: 10,
      expected_effective: { edges: 8, reworkRounds: 2 },
    }, token);
    // The route requires the exact root event id; a wrong root is a 404.
    // (Happy path uses the real root id below.)
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const rootEventId = events.find((e) => e.kind === "steward_message")?.id ?? "";
    const happy = await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: rootEventId,
      edges: 10,
      expected_effective: { edges: 8, reworkRounds: 2 },
    }, token);
    expect(happy.status).toBe(200);
    const body = (await happy.json()) as { status: string; effective: { edges: number; reworkRounds: number } };
    expect(body.status).toBe("updated");
    expect(body.effective).toEqual({ edges: 10, reworkRounds: 2 });
    const after = await readConversationEvents({ vaultRoot: root, conversationId });
    const budgetEvents = after.filter((e) => e.kind === "handoff_budget_updated");
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]?.author).toBe("steward");
    expect(budgetEvents[0]?.handoffBudget).toEqual({ edges: { from: 8, to: 10 } });
  });

  it("CAS mismatch is a 409 carrying the current effective view, with no event", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const rootEventId = events.find((e) => e.kind === "steward_message")?.id ?? "";
    const response = await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: rootEventId,
      edges: 10,
      expected_effective: { edges: 9, reworkRounds: 2 },
    }, token);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; current_effective: { edges: number; reworkRounds: number } };
    expect(body.current_effective).toEqual({ edges: 8, reworkRounds: 2 });
    const after = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(after.some((e) => e.kind === "handoff_budget_updated")).toBe(false);
  });

  it("malformed, non-raising, out-of-cap, and unknown-field POST bodies are bounded 400s with no event", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const rootEventId = events.find((e) => e.kind === "steward_message")?.id ?? "";
    const badBodies = [
      { root_event_id: rootEventId, edges: 4, expected_effective: { edges: 8, reworkRounds: 2 } },
      { root_event_id: rootEventId, edges: 25, expected_effective: { edges: 8, reworkRounds: 2 } },
      { root_event_id: rootEventId, edges: "10", expected_effective: { edges: 8, reworkRounds: 2 } },
      { root_event_id: rootEventId, expected_effective: { edges: 8, reworkRounds: 2 } },
      { root_event_id: rootEventId, edges: 10 },
      { root_event_id: rootEventId, edges: 10, expected_effective: { edges: 8, reworkRounds: 2 }, extra: true },
      { edges: 10, expected_effective: { edges: 8, reworkRounds: 2 } },
      { root_event_id: rootEventId, edges: 10, expected_effective: { edges: 8 } },
    ];
    for (const body of badBodies) {
      const response = await post(url(`/api/conversations/${conversationId}/workflow-budget`), body, token);
      expect(response.status).toBe(400);
    }
    const after = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(after.some((e) => e.kind === "handoff_budget_updated")).toBe(false);
  });

  it("unknown root is a 404; unknown conversation is a 404; no cross-conversation leakage", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const other = await createConversation("Another @zai");
    const unknownRoot = await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: "20260805T140000001Z-not-a-root",
      edges: 10,
      expected_effective: { edges: 8, reworkRounds: 2 },
    }, token);
    expect(unknownRoot.status).toBe(404);
    const unknownConversation = await get(url(`/api/conversations/20260805T140000001Z-nope/agents/zai/workflow-status`), token);
    expect(unknownConversation.status).toBe(404);
    // Status of conversation A cannot see conversation B's facts.
    const otherEvents = await readConversationEvents({ vaultRoot: root, conversationId: other });
    const otherRoot = otherEvents.find((e) => e.kind === "steward_message")?.id ?? "";
    const statusA = (await (await get(url(`/api/conversations/${conversationId}/workflow-budgets`), token)).json()) as {
      association: Record<string, { root_event_id: string } | null>;
    };
    for (const association of Object.values(statusA.association)) {
      if (association !== null) expect(association.root_event_id).not.toBe(otherRoot);
    }
  });

  it("malformed agent name is a 400; a well-formed agent outside the audience is a 404", async () => {
    await startServer();
    const conversationId = await createConversation("Hello @zai");
    const malformed = await get(url(`/api/conversations/${conversationId}/agents/Bad_Agent/workflow-status`), token);
    expect(malformed.status).toBe(400);
    const outside = await get(url(`/api/conversations/${conversationId}/agents/ghost/workflow-status`), token);
    expect(outside.status).toBe(404);
  });
});

describe("Gateway Conversation workflow-budget routes (B4 correction: route error matrix)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-budget-matrix-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-budget-matrix-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function startServer(runnableAgents: string[] = ["zai"], targetBuilder?: () => Promise<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>): Promise<void> {
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents,
      targetBuilder: targetBuilder ?? (async () => fakePiTarget()),
    });
    handle = await server.start();
  }

  async function waitForActiveRun(serverInstance: GatewayServer, conversationId: string, agent: string, timeoutMs = 5000): Promise<void> {
    const broker = (serverInstance as unknown as { conversationBroker: ConversationBroker }).conversationBroker as ConversationBroker;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (broker.hasActiveRun(conversationId, agent)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("run did not become active in time");
  }

  it("an active agent-first non-C5 run reports run_active true with workflow null over the status route", async () => {
    // A minimal hanging fake Pi: acks every prompt, emits agent_start, never
    // settles — so the agent-first greeting run stays active deterministically.
    const hangingScript = join(root, "hanging-fake-pi.cjs");
    await writeFile(
      hangingScript,
      [
        '"use strict";',
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  let index;",
        "  while ((index = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, index);",
        "    buffer = buffer.slice(index + 1);",
        "    if (!line.trim()) continue;",
        "    try {",
        "      const cmd = JSON.parse(line);",
        "      if (cmd.type === 'prompt') {",
        "        process.stdout.write(JSON.stringify({ type: 'response', command: 'prompt', success: true, id: cmd.id }) + '\\n');",
        "        process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');",
        "      }",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    await startServer(["zai"], async () => ({
      command: process.execPath,
      args: [hangingScript],
      cwd: process.cwd(),
      env: process.env,
    }));
    // The start route AWAITS the run outcome, so with a hanging fake Pi the
    // POST stays pending while the run is active. Fire it, then read the
    // durable conversation id from the list route.
    const startPromise = post(url("/api/conversations/start"), { agent: "zai" }, token);
    startPromise.catch(() => {}); // the hanging run keeps this pending; afterEach closes the server
    const deadline = Date.now() + 4000;
    let conversationId = "";
    while (Date.now() < deadline && conversationId === "") {
      const list = (await (await get(url("/api/conversations"), token)).json()) as {
        conversations: Array<{ id: string }>;
      };
      conversationId = list.conversations[0]?.id ?? "";
      if (conversationId === "") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(conversationId).not.toBe("");

    await waitForActiveRun(server, conversationId, "zai");
    const response = await get(url(`/api/conversations/${conversationId}/agents/zai/workflow-status`), token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run_active: boolean; workflow: null };
    expect(body.run_active).toBe(true);
    expect(body.workflow).toBeNull();
  });

  it("an archived conversation rejects the CAS update with a bounded 409 and no event", async () => {
    await startServer();
    const createResponse = await post(url("/api/conversations"), { text: "Hello @zai" }, token);
    const conversationId = ((await createResponse.json()) as { conversation: { id: string } }).conversation.id;
    const archive = await post(url(`/api/conversations/${conversationId}/archive`), {}, token);
    expect(archive.status).toBe(200);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const rootEventId = events.find((e) => e.kind === "steward_message")?.id ?? "";

    const response = await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: rootEventId,
      edges: 10,
      expected_effective: { edges: 8, reworkRounds: 2 },
    }, token);
    expect(response.status).toBe(409);
    const after = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(after.some((e) => e.kind === "handoff_budget_updated")).toBe(false);
  });

  it("mutation-lock contention rejects the CAS update with a bounded 409 and no side effects", async () => {
    await startServer();
    const createResponse = await post(url("/api/conversations"), { text: "Hello @zai" }, token);
    const conversationId = ((await createResponse.json()) as { conversation: { id: string } }).conversation.id;
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const rootEventId = events.find((e) => e.kind === "steward_message")?.id ?? "";

    // An independent holder (simulated second process) owns the lock.
    const external = await acquireConversationMutationLock({ vaultRoot: root, conversationId, now: () => new Date() });
    const response = await post(url(`/api/conversations/${conversationId}/workflow-budget`), {
      root_event_id: rootEventId,
      edges: 10,
      expected_effective: { edges: 8, reworkRounds: 2 },
    }, token);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/busy|lock/i);
    await external.release();

    // Zero side effects: no event, manifest untouched, no dispatch.
    const after = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(after.some((e) => e.kind === "handoff_budget_updated")).toBe(false);
    const manifest = await readFile(join(root, "collaboration", "conversations", conversationId, "index.md"), "utf8");
    expect(manifest).not.toContain("- dipu");
  });
});
