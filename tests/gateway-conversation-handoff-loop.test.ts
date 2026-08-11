import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversation, readConversationEvents } from "../src/conversations.js";
import type { ConversationEventRecord } from "../src/conversations.js";

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

/** Decode an SSE `event: <type>\ndata: <json>` frame from a live buffer. */
function parseSseFrames(buffer: string): { type: string; data: Record<string, unknown> }[] {
  const frames: { type: string; data: Record<string, unknown> }[] = [];
  const pattern = /event: ([a-z_]+)\ndata: (\{.*?\})\n\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buffer)) !== null) {
    try {
      frames.push({ type: match[1] ?? "", data: JSON.parse(match[2] ?? "{}") as Record<string, unknown> });
    } catch {
      // ignore malformed/partial frames
    }
  }
  return frames;
}

describe("C5-3 authenticated gateway conversation-handoff loop (fake Pi)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-c5-3-token";
  const agents = ["sam", "dipu", "kimi"];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-c5-3-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: agents,
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversationViaApi(text: string): Promise<string> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    return body.conversation?.id ?? "";
  }

  async function openStream(conversationId: string): Promise<{
    approvals: Record<string, unknown>[];
    events: ConversationEventRecord[];
    cancel: () => Promise<void>;
  }> {
    const approvals: Record<string, unknown>[] = [];
    const events: ConversationEventRecord[] = [];
    const stream = await fetch(url(`/api/conversations/${conversationId}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen = new Set<string>();
    const readLoop = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const frame of parseSseFrames(buffer)) {
          // parseSseFrames re-parses the whole buffer; dedupe by identity so
          // a growing buffer never duplicates a frame.
          const key = `${frame.type}:${JSON.stringify(frame.data)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (frame.type === "approval") approvals.push(frame.data);
          if (frame.type === "conversation_event" && frame.data.kind !== undefined) {
            events.push(frame.data as unknown as ConversationEventRecord);
          }
        }
      }
    })();
    void readLoop;
    return {
      approvals,
      events,
      cancel: async () => {
        await reader.cancel().catch(() => {});
      },
    };
  }

  it("runs the steward-approved Sam→Dipu→Kimi→Sam→Dipu loop with live SSE gate confirmation and exact root/workflow decoration", async () => {
    const conversationId = await createConversationViaApi("Seed no mention");
    const stream = await openStream(conversationId);

    // The root (sam) requests the initial gate to dipu through the gated tool.
    // The handoff text embeds the bounded remainder chain so each workflow
    // stage carries only its own next link (fixture contract).
    const rootText =
      "Please review the diff, then conversationhandoff->kimi:Review it further, then conversationhandoff->sam:Verify it, then conversationhandoff->dipu:Final check.";
    const dispatch = post(url(`/api/conversations/${conversationId}/messages`), { text: `conversationhandoff->dipu:${rootText} @sam` }, token);

    // The live gate card arrives while the root run is held (live-only, no replay).
    await waitForStreamValue(async () => stream.approvals.length >= 1);
    const gate = stream.approvals[0] as Record<string, unknown>;
    expect(Object.keys(gate).sort()).toEqual(["agent", "conversationId", "method", "payload", "requestId"]);
    expect(gate.agent).toBe("sam");
    expect(gate.method).toBe("confirm");
    expect((gate.payload as { to?: string }).to).toBe("dipu");
    expect(String((gate.payload as { text?: string }).text ?? "")).toContain("Please review the diff");

    // No handoff/audience effect before confirmation.
    let events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(0);
    expect((await readConversation({ vaultRoot: root, conversationId })).audience).toEqual(["sam"]);

    // Confirmation through the existing approve route accepts the stored edge.
    const approve = await post(url(`/api/conversations/${conversationId}/approve`), { agent: "sam", request_id: gate.requestId, confirmed: true }, token);
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ ok: true });

    // The whole sequential chain resolves after the final stage completes.
    const response = await dispatch;
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "sam", status: "completed" }]);

    events = await readConversationEvents({ vaultRoot: root, conversationId });
    const rootId = events[1]?.id ?? "";
    expect(events[0]?.kind).toBe("steward_message"); // seed
    expect(events[1]?.kind).toBe("steward_message"); // dispatch

    // Exactly four handoff edges, in order, all correlated to the dispatch root.
    const handoffs = events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string");
    expect(handoffs.map((e) => `${e.author}->${e.addressedAgent}`)).toEqual(["sam->dipu", "dipu->kimi", "kimi->sam", "sam->dipu"]);
    for (const handoff of handoffs) {
      expect(handoff.correlationId).toBe(rootId);
    }

    // Role decoration is visible in durable evidence: the root reply carries
    // [role:root]; the three intermediate stages that handed off carry
    // [role:workflow]; the final terminal stage completes the chain with no
    // further handoff (plain fixture completion).
    const replies = events.filter((e) => e.kind === "agent_message" && e.addressedAgent === undefined);
    expect(replies).toHaveLength(5);
    expect(String(replies[0]?.body)).toContain("[role:root]");
    expect(String(replies[0]?.body)).toContain("Handoff settled (pending)");
    const stageReplies = replies.slice(1);
    const handoffStageReplies = stageReplies.filter((r) => String(r.body).includes("conversation handoff"));
    expect(handoffStageReplies).toHaveLength(3);
    for (const reply of handoffStageReplies) {
      expect(String(reply.body)).toContain("[role:workflow]");
      expect(String(reply.body)).toContain("Handoff settled (ok)");
    }
    expect(String(stageReplies.at(-1)?.body)).toBe("Hello");

    // Sequential lifecycle: root first, then one stage at a time; each child
    // run_started correlates to its parent handoff and follows the parent
    // terminal; every terminal is completed.
    const started = events.filter((e) => e.kind === "run_started");
    const finished = events.filter((e) => e.kind === "run_finished");
    expect(started).toHaveLength(5);
    expect(finished).toHaveLength(5);
    expect(finished.every((f) => f.runStatus === "completed")).toBe(true);
    expect(started[0]?.correlationId).toBe(rootId);
    for (let i = 1; i < started.length; i++) {
      expect(started[i]?.correlationId).toBe(handoffs[i - 1]?.id);
      expect(started[i]?.sequence ?? 0).toBeGreaterThan(finished[i - 1]?.sequence ?? 0);
    }
    for (let i = 0; i < finished.length; i++) {
      const expectedRoot = i === 0 ? rootId : handoffs[i - 1]?.id;
      expect(finished[i]?.correlationId).toBe(expectedRoot);
    }

    // Exactly one approval frame ever: the root gate. No stage gets a second
    // gate (workflow envelopes are answered via the control path, never SSE).
    await waitForStreamValue(async () => stream.events.length >= events.length - 2);
    expect(stream.approvals).toHaveLength(1);
    await stream.cancel();
  });

  it("an ordinary conversation message produces no gate and no loop evidence", async () => {
    const conversationId = await createConversationViaApi("Seed no mention");
    const stream = await openStream(conversationId);
    const dispatch = post(url(`/api/conversations/${conversationId}/messages`), { text: "plain @sam" }, token);
    const response = await dispatch;
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "sam", status: "completed" }]);

    // No gate card, no handoff edge, no audience growth beyond the mention.
    expect(stream.approvals).toHaveLength(0);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(0);
    await stream.cancel();
  });
});
