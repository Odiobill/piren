import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";

/**
 * P7 — accepted pilot correction (`conversation-p7-pilot-correction-contract.md`):
 * the EXACT real Pi 0.83 production-protocol trace (session-start fire-and-forget
 * `extension_ui_request{method:"notify"}` + user/custom messages + repeated
 * assistant error record in message_start/message_end/turn_end/agent_end.messages
 * + agent_settled) must classify as a truthful zero-side-effect provider error
 * through the BUILT production path (gateway + conversation broker + fake Pi RPC
 * process), never as "completed": no agent_message, existing failed/provider_error
 * terminal, exact bounded non-secret body, no raw 403/RegionError/model/workspace
 * internals. P6's clean `providererror-empty` fixture omitted the session-start
 * notify, so P6 passed while the real pilot mislabeled the run as completed.
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

async function waitForStreamValue(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("stream condition not met in time");
}

describe("P7 gateway pilot corrections — real-protocol terminal-error classification", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-p7-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-p7-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
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
    const body = (await response.json()) as Record<string, unknown>;
    return { id: (body.conversation as { id?: string } | undefined)?.id ?? "" };
  }

  async function eventKinds(conversationId: string): Promise<string[]> {
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    return events.map((e) => e.kind);
  }

  it("exact real-protocol trace (startup notify + user/custom + repeated error + settled) records failed/provider_error, no agent_message, no raw error internals", async () => {
    await startServer();
    const { id } = await createConversationViaApi("providererror-real @fake");
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    const terminal = events.at(-1);
    expect(terminal?.runStatus).toBe("failed");
    expect(terminal?.failureKind).toBe("provider_error");
    expect(terminal?.correlationId).toBe(events[0]?.id);
    expect(terminal?.runAgent).toBe("fake");
    // Exact bounded non-secret body; never raw provider text or internals.
    expect(terminal?.body).toBe("Run ended with a provider error.");
    expect(terminal?.body).not.toContain("403");
    expect(terminal?.body).not.toContain("RegionError");
    expect(terminal?.body).not.toContain("opencode");
    expect(terminal?.body).not.toContain("deepseek");
    expect(terminal?.body).not.toContain("workspace");
  });

  it("the same real trace WITHOUT the startup notify keeps the truthful provider_error terminal (P7 matrix pin)", async () => {
    await startServer();
    const { id } = await createConversationViaApi("providererror-empty @fake");
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    expect(events.at(-1)?.runStatus).toBe("failed");
    expect(events.at(-1)?.failureKind).toBe("provider_error");
  });

  it("a genuinely empty normal completion still persists completed with no agent_message (P5 pin, unchanged by P7)", async () => {
    await startServer();
    const { id } = await createConversationViaApi("emptyoutput @fake");
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_finished"));
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    expect(events.map((e) => e.kind)).toEqual(["steward_message", "run_started", "run_finished"]);
    expect(events.at(-1)?.runStatus).toBe("completed");
  });
});
