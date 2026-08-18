import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversation, readConversationEvents } from "../src/conversations.js";
import { extractConversationTaskPath } from "../src/conversation-task-path.js";
import extension from "../src/pi-extension.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

/**
 * T5 — C6 task-directed loop mechanics (ADR-0045, contract §7 T5). A
 * scripted, protocol-following fake agent drives the authenticated gateway
 * Conversation loop while REAL extension task tools (send_to_agent,
 * task_claim, task_update_status, vault_read) perform every task operation on
 * the same temp vault. These tests prove mechanically observable behavior and
 * tool boundaries ONLY — never real-model compliance with the T2 prompt
 * discipline (that requires separately recorded live-validation evidence).
 */

let root: string;
let server: GatewayServer;
let handle: GatewayHandle;
let scriptFile: string;
const token = "test-c6-token";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-gateway-c6-loop-"));
  await initVault({ vaultRoot: root, agentName: "piren" });
  for (const agent of ["sam", "dipu"]) {
    const dir = join(root, "team", agent);
    await mkdir(join(dir, "inbox"), { recursive: true });
    await mkdir(join(dir, "logs"), { recursive: true });
    await mkdir(join(dir, "outbox"), { recursive: true });
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "SOUL.md"), `# ${agent}\n`);
    await writeFile(join(dir, "MEMORY.md"), "# Memory\n");
    await writeFile(join(dir, "config.yml"), "model: {}\n");
  }
  scriptFile = join(root, "c6-script.json");
});

afterEach(async () => {
  if (server !== undefined) {
    await server.close().catch(() => {});
    server = undefined as unknown as GatewayServer;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fakePi() {
  const tools: Record<string, any> = {};
  const events: Record<string, Function[]> = {};
  return {
    tools,
    events,
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
    on(event: string, handler: Function) {
      events[event] ??= [];
      events[event].push(handler);
    },
  };
}

/** Boot the REAL Piren extension for one agent against the shared temp vault. */
async function bootAgent(agent: string) {
  const pi = fakePi();
  await extension(pi as any, {
    cliAgentDir: join(root, "team", agent),
    env: { PIREN_DEVICE_ID: `test-${agent}`, PIREN_HOSTNAME: `test-${agent}` },
    configPath: join(root, "missing-local-config.yml"),
  });
  return pi;
}

async function startServer(): Promise<void> {
  server = new GatewayServer({
    target: {
      command: process.execPath,
      args: [fakePiScript],
      cwd: process.cwd(),
      env: process.env,
    },
    authToken: token,
    vaultRoot: root,
    runnableAgents: ["sam", "dipu"],
    targetBuilder: async () => ({
      command: process.execPath,
      args: [fakePiScript],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_PI_SCRIPT_FILE: scriptFile, FAKE_PI_SCRIPT_TIMEOUT_MS: "10000" },
    }),
  });
  handle = await server.start();
}

function url(path: string): string {
  return `http://${handle.hostname}:${handle.port}${path}`;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

async function openStream(conversationId: string): Promise<{ approvals: Record<string, unknown>[]; cancel: () => Promise<void> }> {
  const approvals: Record<string, unknown>[] = [];
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
      for (const block of buffer.split("\n\n")) {
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const raw = /^data: (.+)$/m.exec(block)?.[1];
        if (type === undefined || raw === undefined) continue;
        const key = `${type}:${raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (type === "approval") approvals.push(data);
        } catch {
          // incomplete chunk; the next iteration re-parses the full buffer
        }
      }
    }
  })();
  void readLoop;
  return {
    approvals,
    cancel: async () => {
      await reader.cancel().catch(() => {});
    },
  };
}

describe("T5 C6 task-directed loop mechanics (authenticated fake-Pi + real extension tools)", () => {
  it("runs the full exact-path Lead → Developer → Lead loop with bidirectional task/conversation correlation", { timeout: 30000 }, async () => {
    const sam = await bootAgent("sam");
    const dipu = await bootAgent("dipu");
    await startServer();

    // 1. Scripted Lead creates the ordinary Developer task via the real tool.
    const created = await sam.tools.send_to_agent.execute("c1", {
      to: "dipu",
      title: "Implement the C6 slice",
      body: "Bounded slice: prove the C6 task-directed loop mechanics.",
    });
    const pathDev = created.details.path as string;
    expect(pathDev).toMatch(/^team\/dipu\/inbox\/.+\.md$/);
    expect(created.details.from).toBe("sam");
    expect(created.details.to).toBe("dipu");
    expect(created.details.status).toBe("pending");

    const conversationId = (await (await post("/api/conversations", { text: "Seed no mention" })).json() as any).conversation.id as string;
    const stream = await openStream(conversationId);

    // 2. The root handoff text carries the exact returned task path.
    const dispatch = post(`/api/conversations/${conversationId}/messages`, {
      text: `conversationhandoff->dipu:c6script Claim ${pathDev} and execute it. @sam`,
    });

    await waitFor(async () => stream.approvals.length >= 1);
    const gate = stream.approvals[0] as Record<string, unknown>;
    expect(gate.agent).toBe("sam");
    expect(gate.method).toBe("confirm");
    expect(String((gate.payload as { text?: unknown }).text)).toContain(pathDev);

    // 3. The steward confirms the initial gate (existing C5 approve route).
    const approve = await post(`/api/conversations/${conversationId}/approve`, { agent: "sam", request_id: gate.requestId, confirmed: true });
    expect(approve.status).toBe(200);

    // 4. The Developer stage run starts (sequential defer-launch after the root).
    await waitFor(async () => (await readConversationEvents({ vaultRoot: root, conversationId })).filter((e) => e.kind === "run_started").length >= 2);

    // 5. Scripted Developer: inspect, claim exactly, complete with evidence,
    // and create the Lead review-request referencing the developer path.
    const readBack = await dipu.tools.vault_read.execute("c2", { path: pathDev });
    expect(readBack.content[0].text).toContain("Implement the C6 slice");
    const claim = await dipu.tools.task_claim.execute("c3", { task_path: pathDev, device_id: "test-dipu" });
    expect(claim.content[0].text).toContain("Claimed task");
    const claimedDev = claim.details.path as string;
    expect(claimedDev).toContain(".claimed.test-dipu.md");
    const done = await dipu.tools.task_update_status.execute("c4", {
      task_path: claimedDev,
      status: "completed",
      result: "Implemented the slice; scripted evidence recorded.",
    });
    expect(done.details.status).toBe("completed");
    const review = await dipu.tools.send_to_agent.execute("c5", {
      to: "sam",
      title: "Review the C6 slice",
      body: `Please review the completed work. Developer task: ${pathDev} (claimed as ${claimedDev}, completed with evidence).`,
    });
    const pathReview = review.details.path as string;
    expect(pathReview).toMatch(/^team\/sam\/inbox\/.+\.md$/);
    expect(review.details.from).toBe("dipu");

    // 6. Publish the scripted return handoff for the held Developer stage run.
    //    The return text carries the exact review path AND the hold token that
    //    keeps the Lead stage live until the lead choreography releases it.
    await writeFile(
      scriptFile,
      JSON.stringify([{ match: pathDev, to: "sam", text: `Review ${pathReview} and record the verdict. c6hold:lead-review` }]),
      "utf8",
    );

    // 7. The Lead stage run launches and stays LIVE (hold token) while the
    //    scripted Lead inspects, claims, and records the verdict inside it.
    await waitFor(async () => (await readConversationEvents({ vaultRoot: root, conversationId })).filter((e) => e.kind === "run_started").length >= 3);
    const reviewRead = await sam.tools.vault_read.execute("c6", { path: pathReview });
    expect(reviewRead.content[0].text).toContain(pathDev);
    const leadClaim = await sam.tools.task_claim.execute("c7", { task_path: pathReview, device_id: "test-sam" });
    const claimedReview = leadClaim.details.path as string;
    expect(claimedReview).toContain(".claimed.test-sam.md");
    await sam.tools.task_update_status.execute("c8", {
      task_path: claimedReview,
      status: "completed",
      result: "Accepted: evidence verified; scope respected.",
    });
    // Release the held Lead stage with its visible verdict report.
    await writeFile(
      scriptFile,
      JSON.stringify({ releases: { "lead-review": `Verdict recorded inside the Lead stage: accepted. Review ${pathReview} completed; developer task ${pathDev} evidence verified.` } }),
      "utf8",
    );

    // 8. The whole sequential chain resolves only after the Lead stage settles.
    const response = await dispatch;
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { dispatch: { agent: string; status: string }[] };
    expect(outcome.dispatch).toEqual([{ agent: "sam", status: "completed" }]);

    // 9. Durable conversation evidence is path-exact and bidirectional, and
    //    the verdict report is durable Lead-stage evidence (not post-settle).
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const handoffs = events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string");
    expect(handoffs.map((e) => `${e.author}->${e.addressedAgent}`)).toEqual(["sam->dipu", "dipu->sam"]);
    expect(handoffs[0]?.body).toContain(pathDev);
    expect(handoffs[1]?.body).toContain(pathReview);
    expect(extractConversationTaskPath(handoffs[0]?.body ?? "")).toEqual({ ok: true, path: pathDev });
    expect(extractConversationTaskPath(handoffs[1]?.body ?? "")).toEqual({ ok: true, path: pathReview });
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "run_finished" && e.runStatus === "completed")).toHaveLength(3);
    // Durable events use only existing kinds — no task/telemetry event kinds.
    expect(new Set(events.map((e) => e.kind)).size).toBeLessThanOrEqual(4);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["sam", "dipu"]);
    const verdictReply = events.find((e) => e.kind === "agent_message" && e.author === "sam" && e.addressedAgent === undefined && e.body.includes("Verdict recorded inside the Lead stage"));
    expect(verdictReply).toBeDefined();
    expect(verdictReply?.body).toContain(pathReview);

    // 10. Task files keep the ordinary schema and carry the exact references.
    const devContent = await readFile(join(root, claimedDev), "utf8");

    // Causal ordering, captured explicitly: the Developer task existed BEFORE
    // the dispatch steward_message that requested the gate.
    const dispatchEvent = events.find((e) => e.kind === "steward_message" && e.body.includes("conversationhandoff->"));
    const devCreatedLine = /\ncreated: (.+)\n/.exec(devContent)?.[1] ?? "";
    expect(devCreatedLine).not.toBe("");
    expect(devCreatedLine <= (dispatchEvent?.created ?? "")).toBe(true);

    expect(devContent).toContain("type: Task");
    expect(devContent).toContain("from: sam");
    expect(devContent).toContain("to: dipu");
    expect(devContent).toContain("status: completed");
    expect(devContent).toContain("requires_approval: false");
    expect(devContent).not.toContain("conversation_id");
    const reviewContent = await readFile(join(root, claimedReview), "utf8");
    expect(reviewContent).toContain("from: dipu");
    expect(reviewContent).toContain("to: sam");
    expect(reviewContent).toContain("status: completed");
    expect(reviewContent).toContain(pathDev);
    expect(reviewContent).toContain("Accepted: evidence verified");

    await stream.cancel();
  });

  it("gate rejection: no dispatch/audience/handoff/budget side effects; the Lead records cancelled on the exact pre-created task", { timeout: 30000 }, async () => {
    const sam = await bootAgent("sam");
    await bootAgent("dipu");
    await startServer();

    // The Lead creates the Developer task BEFORE requesting the gate.
    const created = await sam.tools.send_to_agent.execute("c1", {
      to: "dipu",
      title: "Implement the rejected slice",
      body: "This task must be cancelled explicitly if the gate is rejected.",
    });
    const pathDev = created.details.path as string;

    const conversationId = (await (await post("/api/conversations", { text: "Seed no mention" })).json() as any).conversation.id as string;
    const stream = await openStream(conversationId);
    const dispatch = post(`/api/conversations/${conversationId}/messages`, {
      text: `conversationhandoff->dipu:Claim ${pathDev} and execute it. @sam`,
    });
    await waitFor(async () => stream.approvals.length >= 1);
    const gate = stream.approvals[0] as Record<string, unknown>;

    const reject = await post(`/api/conversations/${conversationId}/approve`, { agent: "sam", request_id: gate.requestId, confirmed: false });
    expect(reject.status).toBe(200);
    const response = await dispatch;
    expect(response.status).toBe(200);

    // No child dispatch, no durable handoff event, no audience growth, no edge.
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(1);
    const manifest = await readConversation({ vaultRoot: root, conversationId });
    expect(manifest.audience).toEqual(["sam"]);

    // The Lead records the specified cancelled outcome with bounded evidence.
    await sam.tools.task_update_status.execute("c2", {
      task_path: pathDev,
      status: "cancelled",
      result: `Cancelled: the steward rejected the initial handoff gate in conversation ${conversationId} (request ${String(gate.requestId)}). No dispatch occurred.`,
    });
    const content = await readFile(join(root, pathDev), "utf8");
    expect(content).toContain("status: cancelled");
    expect(content).toContain("the steward rejected the initial handoff gate");
    expect(content).toContain(conversationId);
    // The cancelled task remains inspectable; it is never deleted.
    const inboxFiles = await readdir(join(root, "team", "dipu", "inbox"));
    expect(inboxFiles.some((name) => name.endsWith(".md") && !name.includes(".claimed."))).toBe(true);

    await stream.cancel();
  });

  it("exact claim failures: missing and already-claimed paths fail closed; cross-inbox claims are hard rejections; no substitute claim", async () => {
    const sam = await bootAgent("sam");
    const dipu = await bootAgent("dipu");

    // Missing exact path: bounded error, nothing claimed.
    const missing = await dipu.tools.task_claim.execute("c1", { task_path: "team/dipu/inbox/20260101T000000000Z-ghost-task.md" });
    expect(missing.isError).toBe(true);

    // Already-claimed exact path: the second claim of the original path fails closed.
    const created = await sam.tools.send_to_agent.execute("c2", { to: "dipu", title: "Claim me once", body: "One claim only." });
    const pathDev = created.details.path as string;
    const first = await dipu.tools.task_claim.execute("c3", { task_path: pathDev, device_id: "test-dipu" });
    expect(first.content[0].text).toContain("Claimed task");
    const second = await dipu.tools.task_claim.execute("c4", { task_path: pathDev });
    expect(second.isError).toBe(true);

    // Cross-inbox claim: hard rejection by the existing path boundary.
    const samTask = await sam.tools.send_to_agent.execute("c5", { to: "sam", title: "Sam only", body: "Not for dipu." });
    const cross = await dipu.tools.task_claim.execute("c6", { task_path: samTask.details.path });
    expect(cross.isError).toBe(true);
    expect(String(cross.content[0].text)).toContain("belongs to agent 'sam'");

    // No substitute claim and no scanning side effects: exactly the one
    // legitimate claimed file exists; sam's task is untouched.
    const dipuInbox = await readdir(join(root, "team", "dipu", "inbox"));
    expect(dipuInbox.filter((name) => name.includes(".claimed."))).toHaveLength(1);
    const samInbox = await readdir(join(root, "team", "sam", "inbox"));
    expect(samInbox.filter((name) => name.includes(".claimed."))).toHaveLength(0);
  });

  it("a live scripted stage visibly reports an exact claim failure and does not improvise", { timeout: 30000 }, async () => {
    const sam = await bootAgent("sam");
    const dipu = await bootAgent("dipu");
    await startServer();

    // The gated handoff names an exact task path that does not exist.
    const ghostPath = "team/dipu/inbox/20260101T000000000Z-ghost-task.md";
    const conversationId = (await (await post("/api/conversations", { text: "Seed no mention" })).json() as any).conversation.id as string;
    const stream = await openStream(conversationId);
    const dispatch = post(`/api/conversations/${conversationId}/messages`, {
      text: `conversationhandoff->dipu:c6hold:dev-claim Inspect and claim ${ghostPath} exactly. @sam`,
    });
    await waitFor(async () => stream.approvals.length >= 1);
    const gate = stream.approvals[0] as Record<string, unknown>;
    expect(String((gate.payload as { text?: unknown }).text)).toContain(ghostPath);
    const approve = await post(`/api/conversations/${conversationId}/approve`, { agent: "sam", request_id: gate.requestId, confirmed: true });
    expect(approve.status).toBe(200);

    // The Developer stage run launches and stays LIVE (hold token) while the
    // scripted Developer attempts the exact claim with the real tool.
    await waitFor(async () => (await readConversationEvents({ vaultRoot: root, conversationId })).filter((e) => e.kind === "run_started").length >= 2);
    const failure = await dipu.tools.task_claim.execute("c1", { task_path: ghostPath, device_id: "test-dipu" });
    expect(failure.isError).toBe(true);
    const failureText = String(failure.content[0].text);

    // The stage visibly reports ONLY the exact condition as its durable reply.
    await writeFile(
      scriptFile,
      JSON.stringify({ releases: { "dev-claim": `Cannot claim ${ghostPath}: ${failureText}. No substitute work attempted.` } }),
      "utf8",
    );
    const response = await dispatch;
    expect(response.status).toBe(200);

    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const report = events.find((e) => e.kind === "agent_message" && e.author === "dipu" && e.addressedAgent === undefined);
    expect(report?.body).toContain(`Cannot claim ${ghostPath}`);
    expect(report?.body).toContain("No substitute work attempted");

    // No substitute claim, no scan-driven work, no retry/reroute/child dispatch.
    const dipuInbox = await readdir(join(root, "team", "dipu", "inbox"));
    expect(dipuInbox.filter((name) => name.includes(".claimed."))).toHaveLength(0);
    expect(events.filter((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(2);

    await stream.cancel();
  });
});
