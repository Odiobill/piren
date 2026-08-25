import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversation, readConversationEvents } from "../src/conversations.js";
import type { ConversationEventRecord } from "../src/conversations.js";

/**
 * VR-5 (gateway layer) — deterministic fake-Pi capture-readiness validation
 * through the REAL GatewayServer against a temp vault. This proves the
 * durable/SSE surface and the VR-1..VR-4 boundaries compose end-to-end over
 * the EXISTING endpoints and event kinds only: C5 handoff loop with bounded
 * tool work, settle-time telemetry, the workbench.yml timed_out deadline with
 * no retry, scoped abort winning over a hanging run, and no transient frame
 * replay on historical/read-only reads.
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

function parseSseFrames(buffer: string): { type: string; data: Record<string, unknown> }[] {
  const frames: { type: string; data: Record<string, unknown> }[] = [];
  const pattern = /event: ([a-z_]+)\ndata: (\{.*?\})\n\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buffer)) !== null) {
    try {
      frames.push({ type: match[1] ?? "", data: JSON.parse(match[2] ?? "{}") as Record<string, unknown> });
    } catch {
      // partial/malformed
    }
  }
  return frames;
}

describe("VR-5 gateway capture-readiness (fake Pi, temp vault)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "vr5-token";
  const agents = ["sam", "zai"];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-vr5-"));
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
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function url(path: string): string {
    return `http://${handle.hostname}:${handle.port}${path}`;
  }

  async function createConversation(text: string): Promise<string> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    return body.conversation?.id ?? "";
  }

  it("runs the steward->sam->(approved)->zai->sam loop with bounded tool work, activity frames, and settle telemetry", { timeout: 30_000 }, async () => {
    const conversationId = await createConversation("Seed no mention");
    // Open the scoped SSE stream and capture live-only frames.
    const approvals: Record<string, unknown>[] = [];
    const activities: Record<string, unknown>[] = [];
    const telemetry: Record<string, unknown>[] = [];
    const streamResponse = await fetch(url(`/api/conversations/${conversationId}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seen = new Set<string>();
    const readLoop = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const frame of parseSseFrames(buffer)) {
          const key = `${frame.type}:${JSON.stringify(frame.data)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (frame.type === "approval") approvals.push(frame.data);
          if (frame.type === "conversation_activity") activities.push(frame.data);
          if (frame.type === "conversation_telemetry") telemetry.push(frame.data);
        }
      }
    })();
    void readLoop;

    // Steward dispatch: @sam root requests the gated handoff to zai; zai's
    // stage section does toolwork then hands back to sam.
    const dispatch = post(
      url(`/api/conversations/${conversationId}/messages`),
      { text: "conversationhandoff->zai:Do toolwork then conversationhandoff->sam:Review complete. @sam" },
      token,
    );

    // The live gate card arrives while the root run is held.
    await waitFor(async () => approvals.length >= 1);
    const gate = approvals[0] as Record<string, unknown>;
    expect(gate.agent).toBe("sam");
    expect(gate.method).toBe("confirm");
    expect(String((gate.payload as { text?: string }).text ?? "")).toContain("Do toolwork");

    // No handoff/audience effect before confirmation.
    let events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(0);

    // Approve the gate through the existing approve route.
    const approve = await post(url(`/api/conversations/${conversationId}/approve`), { agent: "sam", request_id: gate.requestId, confirmed: true }, token);
    expect(approve.status).toBe(200);

    // The two-edge chain resolves.
    const response = await dispatch;
    expect(response.status).toBe(200);

    // Durable evidence: sam->zai handoff, then zai->sam handoff, then sam review.
    await waitFor(async () => {
      const ev = await readConversationEvents({ vaultRoot: root, conversationId });
      return ev.some((e) => e.kind === "agent_message" && e.author === "sam" && e.addressedAgent === undefined && String(e.body).includes("Hel"));
    });
    events = await readConversationEvents({ vaultRoot: root, conversationId });
    const handoffs = events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string");
    expect(handoffs.map((e) => `${e.author}->${e.addressedAgent}`)).toEqual(["sam->zai", "zai->sam"]);
    // Sam's final review is a plain durable reply (the last terminal).
    const replies = events.filter((e) => e.kind === "agent_message" && e.addressedAgent === undefined);
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(String(replies.at(-1)?.body)).toContain("Hel");

    // Activity frames: working + text_delta + tool + settled for at least the
    // root and the toolwork stage; tool frames carry name+status only.
    await waitFor(async () => {
      const latest = activities.length;
      // settle the reader loop after the chain finished
      return latest > 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const toolFrames = activities.filter((a) => a.kind === "tool");
    expect(toolFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of toolFrames) {
      expect(typeof frame.toolName).toBe("string");
      expect(["started", "completed", "failed"]).toContain(frame.status);
      for (const forbidden of ["args", "arguments", "result", "output", "env", "token", "secret"]) {
        expect(frame).not.toHaveProperty(forbidden);
      }
    }
    expect(activities.some((a) => a.kind === "text_delta")).toBe(true);
    expect(activities.some((a) => a.kind === "settled")).toBe(true);

    // Settle-time telemetry frames arrive for at least one settled run.
    await waitFor(async () => telemetry.length >= 1);
    const tframe = telemetry[0] as Record<string, unknown>;
    expect(tframe).toMatchObject({ conversationId, agent: expect.any(String), runId: expect.any(String), contextState: "ok" });

    await reader.cancel().catch(() => {});
  });

  it("a valid short workbench.yml deadline settles a hanging run as timed_out with no retry", async () => {
    // Close the default server and re-create one over the same vault with a
    // 1-second workbench.yml deadline (the closed valid minimum).
    await server.close();
    await writeFile(join(root, "workbench.yml"), "conversation:\n  run_timeout_seconds: 1\n", "utf8");
    server = new GatewayServer({
      target: fakePiTarget(),
      authToken: token,
      vaultRoot: root,
      runnableAgents: agents,
      targetBuilder: async () => fakePiTarget(),
    });
    handle = await server.start();
    expect(server.conversationRunTimeoutMs).toBe(1000);

    const conversationId = await createConversation("Seed timeout");
    const dispatch = post(url(`/api/conversations/${conversationId}/messages`), { text: "hang @zai" }, token);
    const response = await dispatch;
    expect(response.status).toBe(200);

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const finished = events.filter((e) => e.kind === "run_finished");
    expect(finished.length).toBe(1);
    expect(finished[0]?.runStatus).toBe("timed_out");
    // No retry/reroute: exactly one run_started, no second run_finished.
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(1);
  });

  it("a scoped abort wins over a hanging run (cancelled, never timed_out, no retry)", async () => {
    const conversationId = await createConversation("Seed abort");
    const dispatch = post(url(`/api/conversations/${conversationId}/messages`), { text: "hang @zai" }, token);

    // Wait for the run to be active, then abort that exact agent.
    await waitFor(async () => {
      const events = await readConversationEvents({ vaultRoot: root, conversationId });
      return events.some((e) => e.kind === "run_started");
    });
    const abort = await post(url(`/api/conversations/${conversationId}/abort`), { agent: "zai" }, token);
    expect(abort.status).toBe(200);

    const response = await dispatch;
    expect(response.status).toBe(200);
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const cancelled = events.find((e) => e.kind === "run_cancelled");
    expect(cancelled?.runAgent).toBe("zai");
    expect(events.some((e) => e.kind === "run_finished" && e.runStatus === "timed_out")).toBe(false);
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(1);
  });

  it("archived/read-only historical reads never replay transient activity/approval/telemetry frames", async () => {
    const conversationId = await createConversation("Seed read-only");
    // A plain completed run (no handoff) produces durable events only.
    const dispatch = post(url(`/api/conversations/${conversationId}/messages`), { text: "toolwork @zai" }, token);
    await dispatch;

    // Historical event read contains ONLY durable kinds — never transient
    // activity/telemetry/approval frames.
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    for (const event of events) {
      expect(event.kind).not.toBe("conversation_activity");
      expect(event.kind).not.toBe("conversation_telemetry");
      expect(event.kind).not.toBe("approval");
    }
    // The audience remains truthful and the manifest is intact.
    expect((await readConversation({ vaultRoot: root, conversationId })).audience).toContain("zai");
  });
});
