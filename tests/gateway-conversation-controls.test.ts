import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { acquireAudienceLock, readConversation, readConversationEvents } from "../src/conversations.js";
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

describe("Gateway Conversation approval/abort surface (C3-C2)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-conversation-control-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-gateway-conversation-controls-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
  });

  afterEach(async () => {
    await server.close();
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

  async function createConversationViaApi(text: string): Promise<{ id: string; response: Response }> {
    const response = await post(url("/api/conversations"), { text }, token);
    const body = (await response.json()) as { conversation?: { id: string } };
    return { id: body.conversation?.id ?? "", response };
  }

  async function eventKinds(conversationId: string): Promise<string[]> {
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    return events.map((e) => e.kind);
  }

  it("enforces capability 404 and auth 401 before any broker interaction", async () => {
    await startServer({ withConversations: false });
    const noCapApprove = await post(url("/api/conversations/abc/approve"), { agent: "fake", request_id: "r", confirmed: true }, token);
    expect(noCapApprove.status).toBe(404);
    const noCapAbort = await post(url("/api/conversations/abc/abort"), { agent: "fake" }, token);
    expect(noCapAbort.status).toBe(404);

    await startServer({ withConversations: true });
    const noAuthApprove = await post(url("/api/conversations/abc/approve"), { agent: "fake", request_id: "r", confirmed: true });
    expect(noAuthApprove.status).toBe(401);
    const noAuthAbort = await post(url("/api/conversations/abc/abort"), { agent: "fake" });
    expect(noAuthAbort.status).toBe(401);
    const noAuthStream = await fetch(url("/api/conversations/abc/events/stream"));
    expect(noAuthStream.status).toBe(401);
  });

  it("validates approve body exactly-one and maps bounded 400/404/409 without side effects", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Seed @fake");
    const kindsBefore = await eventKinds(id);

    // Missing agent / request_id -> bounded 400.
    expect((await post(url(`/api/conversations/${id}/approve`), { request_id: "r", confirmed: true }, token)).status).toBe(400);
    expect((await post(url(`/api/conversations/${id}/approve`), { agent: "fake", confirmed: true }, token)).status).toBe(400);

    // Non-exactly-one response -> bounded 400 with the core message.
    const empty = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: "r" }, token);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe("Exactly one of confirmed, value, or cancelled is required.");
    expect((await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: "r", confirmed: true, value: "x" }, token)).status).toBe(400);
    expect((await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: "r", confirmed: "yes" }, token)).status).toBe(400);

    // Unknown/stale request -> bounded strict 409 with the contract message.
    const stale = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: "nope", confirmed: true }, token);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/Unknown or stale approval request 'nope' for conversation '.*' and agent 'fake'\./);

    // Unknown conversation -> 404.
    expect((await post(url("/api/conversations/does-not-exist/approve"), { agent: "fake", request_id: "r", confirmed: true }, token)).status).toBe(404);

    // No side effects: no events were appended by any rejected control.
    expect(await eventKinds(id)).toEqual(kindsBefore);
  });

  it("maps a malformed conversation id on approve to the family 404, never a 500", async () => {
    await startServer();
    // `bad_id!` fails CONVERSATION_ID_PATTERN inside readConversation; the
    // conversation route family maps an invalid id to a bounded 404 (the same
    // convention as conversationError), never a 500 "internal error".
    const response = await post(url("/api/conversations/bad_id!/approve"), { agent: "fake", request_id: "r", confirmed: true }, token);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("Invalid conversation id. Use the deterministic compact-UTC id.");
  });

  it("emits a live approval SSE frame only for the matching conversation and delivers the approval exactly once", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Seed no mention");

    const streamResponse = await fetch(url(`/api/conversations/${id}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let approvalId = "";
    let sawTerminal = false;
    const readStream = (async () => {
      while (!sawTerminal) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const frame of parseSseFrames(buffer)) {
          if (frame.type === "approval" && approvalId === "") {
            approvalId = String(frame.data.requestId ?? "");
          }
          if (frame.type === "conversation_event" && frame.data.kind === "run_finished") {
            sawTerminal = true;
          }
        }
      }
    })();

    const dispatch = post(url(`/api/conversations/${id}/messages`), { text: "waitapprove @fake" }, token);
    await waitForStreamValue(async () => approvalId !== "");

    // Bounded frame: only conversationId/agent/requestId/method/payload.
    const approvalFrame = parseSseFrames(buffer).find((f) => f.type === "approval");
    expect(approvalFrame?.data).toMatchObject({
      conversationId: id,
      agent: "fake",
      method: "confirm",
    });
    expect(Object.keys(approvalFrame?.data ?? {})).toEqual(["conversationId", "agent", "requestId", "method", "payload"]);

    const approve = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: approvalId, confirmed: true }, token);
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ ok: true });

    const outcome = (await (await dispatch).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
    await waitForStreamValue(async () => sawTerminal);
    await readStream;
    await reader.cancel().catch(() => {});

    // Durable events: ordinary kinds only, no approval record/payload.
    expect(await eventKinds(id)).toEqual(["steward_message", "steward_message", "run_started", "agent_message", "run_finished"]);

    // Historic events route never replays approvals.
    const history = (await (await fetch(url(`/api/conversations/${id}/events`), { headers: { authorization: `Bearer ${token}` } })).json()) as {
      events: { kind: string }[];
    };
    expect(history.events.map((e) => e.kind)).toEqual(["steward_message", "steward_message", "run_started", "agent_message", "run_finished"]);
    expect(history.events.some((e) => e.kind.toLowerCase().includes("approval"))).toBe(false);
  });

  it("never cross-delivers the same request id across conversations and keeps each pending", async () => {
    await startServer();
    const convA = (await createConversationViaApi("Seed A no mention")).id;
    const convB = (await createConversationViaApi("Seed B no mention")).id;

    // Open both live streams FIRST so each pending approval frame is observed.
    async function openApprovalWatcher(conversationId: string): Promise<{ idPromise: Promise<string>; cancel: () => Promise<void> }> {
      const stream = await fetch(url(`/api/conversations/${conversationId}/events/stream`), {
        headers: { authorization: `Bearer ${token}` },
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let id = "";
      let resolveId!: (value: string) => void;
      const idPromise = new Promise<string>((resolve) => {
        resolveId = resolve;
      });
      const readLoop = (async () => {
        let buffer = "";
        while (id === "") {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frame = parseSseFrames(buffer).find((f) => f.type === "approval");
          if (frame) {
            id = String(frame.data.requestId ?? "");
            resolveId(id);
          }
        }
      })();
      void readLoop;
      return {
        idPromise,
        cancel: async () => {
          await reader.cancel().catch(() => {});
        },
      };
    }
    const watcherA = await openApprovalWatcher(convA);
    const watcherB = await openApprovalWatcher(convB);

    const dispatchA = post(url(`/api/conversations/${convA}/messages`), { text: "waitapprove @fake" }, token);
    const dispatchB = post(url(`/api/conversations/${convB}/messages`), { text: "waitapprove @fake" }, token);
    const [idA, idB] = await Promise.all([watcherA.idPromise, watcherB.idPromise]);
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    // Fixture contract this test relies on: two isolated fake-Pi processes
    // never emit the same request id (pid+seq suffixed). Pin it explicitly so
    // a uniqueness regression fails here, not as a misleading 409/200 diff.
    expect(idA).not.toBe(idB);

    // The URL conversationId is authoritative: the request id that exists in
    // convA is unknown/stale for convB (bounded 409), nothing is delivered.
    const cross = await post(url(`/api/conversations/${convB}/approve`), { agent: "fake", request_id: idA, confirmed: true }, token);
    expect(cross.status).toBe(409);

    // Approve convA's own request: only convA's run completes.
    const approveA = await post(url(`/api/conversations/${convA}/approve`), { agent: "fake", request_id: idA, confirmed: true }, token);
    expect(approveA.status).toBe(200);
    const outcomeA = (await (await dispatchA).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcomeA.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
    // convB's pending request is untouched and still answerable.
    const approveB = await post(url(`/api/conversations/${convB}/approve`), { agent: "fake", request_id: idB, confirmed: true }, token);
    expect(approveB.status).toBe(200);
    const outcomeB = (await (await dispatchB).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcomeB.dispatch).toEqual([{ agent: "fake", status: "completed" }]);

    await watcherA.cancel();
    await watcherB.cancel();
  });

  it("aborts exactly one run: cancelled outcome, exactly one run_cancelled, then no-active-run", async () => {
    await startServer();
    const { id } = await createConversationViaApi("Seed no mention");

    const dispatch = post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token);
    // Wait until the run is active (run_started persisted).
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_started"));

    const missingAgent = await post(url(`/api/conversations/${id}/abort`), {}, token);
    expect(missingAgent.status).toBe(400);

    const abort = await post(url(`/api/conversations/${id}/abort`), { agent: "fake" }, token);
    expect(abort.status).toBe(200);
    const body = (await abort.json()) as { outcome: { status: string } };
    expect(body.outcome.status).toBe("cancelled");

    const outcome = (await (await dispatch).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "fake", status: "cancelled" }]);

    const kinds = await eventKinds(id);
    expect(kinds.filter((k) => k === "run_cancelled")).toHaveLength(1);
    expect(kinds.filter((k) => k === "run_finished")).toHaveLength(0);

    // Duplicate abort and never-dispatched conversation: no-active-run, no new records.
    const again = await post(url(`/api/conversations/${id}/abort`), { agent: "fake" }, token);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { outcome: { status: string } }).outcome.status).toBe("no-active-run");
    const none = await post(url("/api/conversations/never-dispatched/abort"), { agent: "fake" }, token);
    expect(none.status).toBe(200);
    expect(((await none.json()) as { outcome: { status: string } }).outcome.status).toBe("no-active-run");
    expect((await eventKinds(id)).filter((k) => k === "run_cancelled")).toHaveLength(1);
  });

  it("an approval frame is live-only: a stream opened after emission never receives it (no replay)", async () => {
    // Regression probe for the archived-controls test ordering hazard. The
    // approval frame is delivered ONLY to subscriptions live at emission
    // time (C3-C2: live-only, never in historic events, no replay). A
    // subscriber that opens its stream after the frame was emitted (e.g. a
    // test that dispatches first and subscribes second) can miss it
    // permanently — the emission races with the late subscription because
    // the frame comes from the separate Pi process after run_started is
    // written. Every approval-producing dispatch in this suite MUST
    // therefore establish the scoped live subscription first.
    await startServer();
    const { id } = await createConversationViaApi("Seed no mention");

    // S1: subscribed BEFORE dispatch, so it deterministically receives the
    // approval frame the fake Pi emits during prompt processing.
    const streamOne = await fetch(url(`/api/conversations/${id}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamOne.status).toBe(200);
    const readerOne = streamOne.body!.getReader();
    const decoderOne = new TextDecoder();
    let approvalId = "";
    const readOne = (async () => {
      let buf = "";
      while (approvalId === "") {
        const { value, done } = await readerOne.read();
        if (done) break;
        buf += decoderOne.decode(value, { stream: true });
        const frame = parseSseFrames(buf).find((f) => f.type === "approval");
        if (frame) approvalId = String(frame.data.requestId ?? "");
      }
    })();
    const dispatch = post(url(`/api/conversations/${id}/messages`), { text: "waitapprove @fake" }, token);
    await waitForStreamValue(async () => approvalId !== "");
    // The frame was definitively emitted (and consumed by S1); close S1.
    await readerOne.cancel().catch(() => {});
    await readOne.catch(() => {});

    // S2: a NEW subscriber, opened after the emission — it must receive NO
    // approval frame (no replay, no cache, no queue).
    const streamTwo = await fetch(url(`/api/conversations/${id}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamTwo.status).toBe(200);
    const readerTwo = streamTwo.body!.getReader();
    const decoderTwo = new TextDecoder();
    let bufferTwo = "";
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      const windowTimer = new Promise<"window">((resolve) => {
        setTimeout(() => resolve("window"), Math.max(1, deadline - Date.now()));
      });
      const result = await Promise.race([readerTwo.read(), windowTimer]);
      if (result === "window") break;
      const { value, done } = result;
      if (done) break;
      bufferTwo += decoderTwo.decode(value, { stream: true });
    }
    expect(parseSseFrames(bufferTwo).filter((f) => f.type === "approval")).toEqual([]);
    await readerTwo.cancel().catch(() => {});

    // The pending approval is still answerable from S1's request id (the
    // run stayed active), proving S2's silence was a no-replay property,
    // not a lost run.
    const approve = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: approvalId, confirmed: true }, token);
    expect(approve.status).toBe(200);
    const outcome = (await (await dispatch).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
  });

  it("keeps archived active-run controls answerable and unchanged archive/attach/message behavior", async () => {
    await startServer();

    // Approve a pending request from a run of an archived conversation.
    // Establish the scoped live subscription BEFORE dispatching the
    // approval-producing message: the approval frame is live-only with no
    // replay, so a late subscriber would miss it (see the probe test above).
    const convApprove = (await createConversationViaApi("Seed A no mention")).id;
    const streamA = await fetch(url(`/api/conversations/${convApprove}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(streamA.status).toBe(200);
    const readerA = streamA.body!.getReader();
    const decoderA = new TextDecoder();
    let approvalIdA = "";
    const readA = (async () => {
      let buf = "";
      while (approvalIdA === "") {
        const { value, done } = await readerA.read();
        if (done) break;
        buf += decoderA.decode(value, { stream: true });
        const frame = parseSseFrames(buf).find((f) => f.type === "approval");
        if (frame) approvalIdA = String(frame.data.requestId ?? "");
      }
    })();
    const dispatchApprove = post(url(`/api/conversations/${convApprove}/messages`), { text: "waitapprove @fake" }, token);
    await waitForStreamValue(async () => approvalIdA !== "");
    const archivedApprove = await post(url(`/api/conversations/${convApprove}/archive`), {}, token);
    expect(archivedApprove.status).toBe(200);
    const approveAfterArchive = await post(url(`/api/conversations/${convApprove}/approve`), { agent: "fake", request_id: approvalIdA, confirmed: true }, token);
    expect(approveAfterArchive.status).toBe(200);
    const dispatchAOutcome = (await (await dispatchApprove).json()) as { dispatch: { agent: string; status: string }[] };
    expect(dispatchAOutcome.dispatch).toEqual([{ agent: "fake", status: "completed" }]);
    await readA.catch(() => {});
    await readerA.cancel().catch(() => {});

    // Abort a still-running run of an archived conversation.
    const convAbort = (await createConversationViaApi("Seed B no mention")).id;
    const dispatchAbort = post(url(`/api/conversations/${convAbort}/messages`), { text: "hang @fake" }, token);
    await waitForStreamValue(async () => (await eventKinds(convAbort)).includes("run_started"));
    const archivedAbort = await post(url(`/api/conversations/${convAbort}/archive`), {}, token);
    expect(archivedAbort.status).toBe(200);
    const abortAfterArchive = await post(url(`/api/conversations/${convAbort}/abort`), { agent: "fake" }, token);
    expect(abortAfterArchive.status).toBe(200);
    expect(((await abortAfterArchive.json()) as { outcome: { status: string } }).outcome.status).toBe("cancelled");
    const dispatchBOutcome = (await (await dispatchAbort).json()) as { dispatch: { agent: string; status: string }[] };
    expect(dispatchBOutcome.dispatch).toEqual([{ agent: "fake", status: "cancelled" }]);
    expect((await eventKinds(convAbort)).filter((k) => k === "run_cancelled")).toHaveLength(1);

    // Archive/attach/message behavior unchanged: archived attach and message
    // still fail closed 409; approve/abort never revive them.
    const attach = await post(url(`/api/conversations/${convApprove}/attach`), {}, token);
    expect(attach.status).toBe(409);
    const message = await post(url(`/api/conversations/${convApprove}/messages`), { text: "More @fake" }, token);
    expect(message.status).toBe(409);
  });

  it("C5-2: a root pending gate raises a live approval SSE frame and confirm accepts one edge through the approve route", async () => {
    await startServer({ runnableAgents: ["fake", "fake2"] });
    const { id } = await createConversationViaApi("Seed no mention");

    // Open the scoped live stream BEFORE the gate frame is emitted: approval
    // frames are live-only with no replay (see the no-replay probe test).
    const stream = await fetch(url(`/api/conversations/${id}/events/stream`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gateId = "";
    const readLoop = (async () => {
      while (gateId === "") {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frame = parseSseFrames(buffer).find((f) => f.type === "approval" && String(f.data.method ?? "") === "confirm");
        if (frame) gateId = String(frame.data.requestId ?? "");
      }
    })();
    void readLoop;

    // Dispatch a steward message to the root lead; the fake Pi holds the run.
    const dispatch = post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token);
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_started"));

    // C5-2 broker seam: the gated `conversation_handoff` tool (C5-3) calls
    // requestInitialHandoffGate on the broker; the gateway test reaches the
    // same seam directly because the tool is not registered until C5-3.
    const broker = (server as unknown as { conversationBroker: ConversationBroker }).conversationBroker as ConversationBroker;
    const gate = await broker.requestInitialHandoffGate(id, "fake", { to: "fake2", text: "Please review the diff" });
    expect(gate.status).toBe("pending");
    if (gate.status !== "pending") throw new Error("expected pending");

    // Live-only gate frame with the bounded five-key approval shape.
    await waitForStreamValue(async () => gateId !== "");
    const frame = parseSseFrames(buffer).find((f) => f.type === "approval");
    expect(frame?.data).toMatchObject({ conversationId: id, agent: "fake", method: "confirm" });
    expect(Object.keys(frame?.data ?? {})).toEqual(["conversationId", "agent", "requestId", "method", "payload"]);
    expect((frame?.data.payload as { to: string } | undefined)?.to).toBe("fake2");

    // Before explicit confirmation: NO handoff event, NO audience growth.
    expect((await eventKinds(id)).filter((k) => k === "agent_message")).toHaveLength(0);
    const manifestBefore = await readConversation({ vaultRoot: root, conversationId: id });
    expect(manifestBefore.audience).not.toContain("fake2");

    // Confirmation through the existing approve route accepts the stored edge.
    const approve = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: gate.requestId, confirmed: true }, token);
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ ok: true });
    const events = await readConversationEvents({ vaultRoot: root, conversationId: id });
    const handoff = events.find((e) => e.kind === "agent_message" && e.addressedAgent === "fake2");
    expect(handoff).toBeDefined();
    expect(handoff?.author).toBe("fake");
    const manifestAfter = await readConversation({ vaultRoot: root, conversationId: id });
    expect(manifestAfter.audience).toContain("fake2");

    // Abort the still-active root: fail-closed, no deferred child launches.
    const abort = await post(url(`/api/conversations/${id}/abort`), { agent: "fake" }, token);
    expect(abort.status).toBe(200);
    expect(((await abort.json()) as { outcome: { status: string } }).outcome.status).toBe("cancelled");
    const outcome = (await (await dispatch).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "fake", status: "cancelled" }]);
    // No child run started; no durable approval record ever existed.
    expect((await eventKinds(id)).filter((k) => k === "run_started")).toHaveLength(1);
    expect((await eventKinds(id)).some((k) => k.toLowerCase().includes("approval"))).toBe(false);
    await reader.cancel().catch(() => {});
  });

  it("C5-2: a cancelled gate through the approve route stays bounded with no handoff event and no audience growth", async () => {
    await startServer({ runnableAgents: ["fake", "fake2"] });
    const { id } = await createConversationViaApi("Seed no mention");
    const dispatch = post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token);
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_started"));

    const broker = (server as unknown as { conversationBroker: ConversationBroker }).conversationBroker as ConversationBroker;
    const gate = await broker.requestInitialHandoffGate(id, "fake", { to: "fake2", text: "Please review the diff" });
    if (gate.status !== "pending") throw new Error("expected pending");

    const cancel = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: gate.requestId, cancelled: true }, token);
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ ok: true });
    expect((await eventKinds(id)).filter((k) => k === "agent_message")).toHaveLength(0);
    const manifest = await readConversation({ vaultRoot: root, conversationId: id });
    expect(manifest.audience).not.toContain("fake2");

    const abort = await post(url(`/api/conversations/${id}/abort`), { agent: "fake" }, token);
    expect(abort.status).toBe(200);
    const outcome = (await (await dispatch).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "fake", status: "cancelled" }]);
    expect((await eventKinds(id)).filter((k) => k === "run_started")).toHaveLength(1);
  });

  it("C5-2: a gate confirm whose audience accept is contended maps to the bounded 409 family with no edge", async () => {
    await startServer({ runnableAgents: ["fake", "fake2"] });
    const { id } = await createConversationViaApi("Seed no mention");
    const dispatch = post(url(`/api/conversations/${id}/messages`), { text: "hang @fake" }, token);
    await waitForStreamValue(async () => (await eventKinds(id)).includes("run_started"));

    const broker = (server as unknown as { conversationBroker: ConversationBroker }).conversationBroker as ConversationBroker;
    const gate = await broker.requestInitialHandoffGate(id, "fake", { to: "fake2", text: "Please review the diff" });
    if (gate.status !== "pending") throw new Error("expected pending");

    // Hold the audience lock so the C5-1 M1 accept cannot proceed.
    const lock = await acquireAudienceLock({ vaultRoot: root, conversationId: id });
    const approve = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: gate.requestId, confirmed: true }, token);
    expect(approve.status).toBe(409);
    const body = (await approve.json()) as { error: string };
    expect(body.error).toMatch(/conversation handoff gate could not be accepted/);
    await lock.release();

    // No edge was accepted: no handoff event, no audience growth, and the
    // gate entry was cleared (a retry is now stale).
    expect((await eventKinds(id)).filter((k) => k === "agent_message")).toHaveLength(0);
    const manifest = await readConversation({ vaultRoot: root, conversationId: id });
    expect(manifest.audience).not.toContain("fake2");
    const retry = await post(url(`/api/conversations/${id}/approve`), { agent: "fake", request_id: gate.requestId, confirmed: true }, token);
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: string }).error).toMatch(/Unknown or stale approval request/);

    const abort = await post(url(`/api/conversations/${id}/abort`), { agent: "fake" }, token);
    expect(abort.status).toBe(200);
    const outcome = (await (await dispatch).json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "fake", status: "cancelled" }]);
  });
});
