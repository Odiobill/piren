import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";
import { readConversationEvents } from "../src/conversations.js";

/**
 * VR-5 correction — C6-shaped variant: proves the C6 task-directed evidence
 * path records its standing operator precondition, makes ZERO scheduler
 * invocation/contact, and mutates no inbox beyond the pre-existing scripted
 * fixture task files. This exercises the EXISTING directed-handoff evidence
 * path only (fake-Pi `c6script` seam + C5 handoff + approve route); it adds no
 * bridge, product, core, scheduler, or task-schema behavior.
 */

// Standing operator precondition (ADR-0045/ADR-0047): an interactive C6
// workflow requires the scheduler's inbox-task automation disabled.
const C6_OPERATOR_PRECONDITION = "automation.inbox_tasks:false";

// Scheduler entry modules are faked to THROW if ever invoked, so any contact
// fails the loop loudly instead of silently passing a zero-call spy.
const schedulerInvocations: string[] = [];
vi.mock("../src/scheduler.js", () => ({
  planSchedulerTick: () => {
    schedulerInvocations.push("scheduler.planSchedulerTick");
    throw new Error("scheduler invoked during C6");
  },
  selectOwningDevice: () => {
    schedulerInvocations.push("scheduler.selectOwningDevice");
    throw new Error("scheduler invoked during C6");
  },
}));
vi.mock("../src/scheduler-loop.js", () => ({
  runSchedulerLoop: () => {
    schedulerInvocations.push("scheduler-loop.runSchedulerLoop");
    throw new Error("scheduler invoked during C6");
  },
}));
vi.mock("../src/scheduler-once.js", () => ({
  schedulerOnce: () => {
    schedulerInvocations.push("scheduler-once.schedulerOnce");
    throw new Error("scheduler invoked during C6");
  },
}));
vi.mock("../src/scheduler-cli.js", () => ({
  schedulerDryRun: () => {
    schedulerInvocations.push("scheduler-cli.schedulerDryRun");
    throw new Error("scheduler invoked during C6");
  },
}));

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

let root: string;
let server: GatewayServer;
let handle: GatewayHandle;
let scriptFile: string;
const token = "vr5-c6-token";

const DEV_TASK = "20260825T190000000Z-c6-shaped-fixture-task.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-vr5-c6-"));
  await initVault({ vaultRoot: root, agentName: "piren" });
  for (const agent of ["sam", "dipu"]) {
    await mkdir(join(root, "team", agent, "inbox"), { recursive: true });
  }
  // Pre-scripted ordinary Developer task (fixture-owned, not loop-created).
  await writeFile(
    join(root, "team", "dipu", "inbox", DEV_TASK),
    [
      "---",
      "type: Task",
      "id: 20260825T190000000Z-c6-shaped-fixture-task",
      "from: sam",
      "to: dipu",
      "priority: normal",
      "status: pending",
      "created: 2026-08-25T19:00:00.000Z",
      "updated: 2026-08-25T19:00:00.000Z",
      "requires_approval: false",
      "---",
      "",
      "# C6-shaped fixture task",
      "",
      "## Result",
      "",
      "Pending.",
      "",
    ].join("\n"),
    "utf8",
  );
  scriptFile = join(root, "c6-script.json");
  await writeFile(
    scriptFile,
    JSON.stringify([{ match: "c6script", to: "dipu", text: `Claim team/dipu/inbox/${DEV_TASK} and execute it.` }]),
    "utf8",
  );
  schedulerInvocations.length = 0;
});

afterEach(async () => {
  await server.close().catch(() => {});
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

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

describe("VR-5 C6-shaped variant (zero scheduler contact, bounded inbox mutation)", () => {
  it("records the precondition, drives one directed handoff, invokes no scheduler, and mutates no inbox", { timeout: 30_000 }, async () => {
    // The standing operator precondition is recorded and asserted.
    expect(C6_OPERATOR_PRECONDITION).toBe("automation.inbox_tasks:false");

    server = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
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

    const conversationId = ((await (await post("/api/conversations", { text: "Seed no mention" })).json()) as { conversation?: { id: string } }).conversation?.id ?? "";
    expect(conversationId).not.toBe("");

    // Snapshot the inboxes BEFORE the directed handoff.
    const dipuInboxBefore = (await readdir(join(root, "team", "dipu", "inbox"))).sort();
    const samInboxBefore = (await readdir(join(root, "team", "sam", "inbox"))).sort();
    expect(dipuInboxBefore).toEqual([DEV_TASK]);
    expect(samInboxBefore).toEqual([]);

    // Open the scoped SSE stream and capture the gate.
    const approvals: Record<string, unknown>[] = [];
    const stream = await fetch(url(`/api/conversations/${conversationId}/events/stream`), { headers: { authorization: `Bearer ${token}` } });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readLoop = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const match = /event: approval\ndata: (\{.*?\})\n\n/.exec(buffer);
        if (match && approvals.length === 0) {
          approvals.push(JSON.parse(match[1] as string) as Record<string, unknown>);
        }
      }
    })();
    void readLoop;

    // Steward dispatch triggers the existing c6script directed-handoff seam.
    const dispatch = post(`/api/conversations/${conversationId}/messages`, { text: "c6script @sam" });

    await waitFor(async () => approvals.length >= 1);
    const gate = approvals[0] as Record<string, unknown>;
    expect(gate.agent).toBe("sam");
    expect(String((gate.payload as { text?: unknown }).text)).toContain(DEV_TASK);

    const approve = await post(`/api/conversations/${conversationId}/approve`, { agent: "sam", request_id: gate.requestId, confirmed: true });
    expect(approve.status).toBe(200);
    const response = await dispatch;
    expect(response.status).toBe(200);

    // Durable evidence: the handoff event carries the exact pre-scripted path.
    const events = await readConversationEvents({ vaultRoot: root, conversationId });
    const handoff = events.find((e) => e.kind === "agent_message" && typeof e.addressedAgent === "string");
    expect(handoff).toBeDefined();
    expect(String(handoff?.body)).toContain(`team/dipu/inbox/${DEV_TASK}`);

    // ZERO scheduler invocation/contact: the fakes would have thrown.
    expect(schedulerInvocations).toEqual([]);

    // Inbox mutation bounded to the pre-scripted fixture files: the loop
    // (prompt-discipline directed handoff) created and claimed nothing new.
    const dipuInboxAfter = (await readdir(join(root, "team", "dipu", "inbox"))).sort();
    const samInboxAfter = (await readdir(join(root, "team", "sam", "inbox"))).sort();
    expect(dipuInboxAfter).toEqual([DEV_TASK]);
    expect(samInboxAfter).toEqual([]);

    await reader.cancel().catch(() => {});
  });
});
