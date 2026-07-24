import { describe, expect, it } from "vitest";
import {
  askAgentClassified,
  type PiRpcClientLike,
} from "../src/ask.js";
import type { RpcEvent, RpcSpawnTarget } from "../src/gateway-rpc.js";

// ---------------------------------------------------------------------------
// Classified ask seam (ADR-0038 revision 3)
//
// Classification derives from control-flow position only — never from error
// text, exit codes, or output absence. Exactly two positions may be
// launch_failure: target_build (executor-side) and start_rejection (here).
// Everything at/after the prompt handoff is ambiguous.
// ---------------------------------------------------------------------------

const TARGET: RpcSpawnTarget = {
  command: "fake-pi",
  args: [],
  cwd: "/tmp",
  env: {},
};

type TerminateMode = "none" | "exit" | "error";

class FakeRpcClient implements PiRpcClientLike {
  startError?: Error;
  promptError?: Error;
  events: RpcEvent[] = [];
  terminate: TerminateMode = "none";
  stopCalled = false;
  promptMessages: string[] = [];

  private eventListeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<() => void> = [];

  async start(): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
  }

  async stop(): Promise<void> {
    this.stopCalled = true;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener);
    };
  }

  async prompt(message: string): Promise<void> {
    this.promptMessages.push(message);
    if (this.promptError !== undefined) throw this.promptError;
    // Ack received. Now stream the scripted events, then either terminate or
    // complete (the caller's script must include agent_end for completion).
    for (const event of this.events) {
      for (const listener of [...this.eventListeners]) listener(event);
    }
    if (this.terminate !== "none") {
      // Both the exit and the error path fire exit listeners, mirroring the
      // production PiRpcClient contract.
      for (const listener of [...this.exitListeners]) listener();
    }
  }
}

function factory(client: FakeRpcClient): (target: RpcSpawnTarget) => PiRpcClientLike {
  return () => client;
}

function textEvent(delta: string): RpcEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

describe("askAgentClassified", () => {
  it("returns ok with assembled text and streams tokens on agent_end", async () => {
    const client = new FakeRpcClient();
    client.events = [textEvent("Hel"), textEvent("lo"), { type: "agent_end" }];
    const tokens: string[] = [];
    const outcome = await askAgentClassified(TARGET, "hi", {
      clientFactory: factory(client),
      onToken: (t) => tokens.push(t),
    });
    expect(outcome).toEqual({ ok: true, text: "Hello" });
    expect(tokens.join("")).toBe("Hello");
    expect(client.stopCalled).toBe(true);
  });

  it("classifies a start() rejection as launch_failure at start_rejection", async () => {
    const client = new FakeRpcClient();
    client.startError = new Error("Failed to spawn agent: ENOENT pi binary");
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("launch_failure");
    expect(outcome.failure.milestone).toBe("start_rejection");
    expect(outcome.failure.detail).toContain("ENOENT");
    // The prompt was never attempted.
    expect(client.promptMessages).toEqual([]);
    expect(client.stopCalled).toBe(false);
  });

  it("classifies a prompt rejection as ambiguous at prompt_handoff", async () => {
    const client = new FakeRpcClient();
    client.promptError = new Error("prompt rejected: another prompt is already running");
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("prompt_handoff");
    expect(outcome.failure.detail).toContain("prompt rejected");
    expect(client.stopCalled).toBe(true);
  });

  it("NEGATIVE: a prompt-handoff error containing 'Failed to spawn agent' is still ambiguous", async () => {
    const client = new FakeRpcClient();
    // The message mentions spawning, but the failure happened at the prompt
    // handoff — classification follows control-flow position, never text.
    client.promptError = new Error("Failed to spawn agent: write EPIPE");
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("prompt_handoff");
  });

  it("classifies an ack timeout as ambiguous at prompt_handoff", async () => {
    const client = new FakeRpcClient();
    client.promptError = new Error("Timed out waiting for response to prompt. Stderr: ");
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("prompt_handoff");
  });

  it("settles (no hang) on process exit after the ack with no events: ambiguous post_ack", async () => {
    const client = new FakeRpcClient();
    client.terminate = "exit";
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("post_ack");
    expect(client.stopCalled).toBe(true);
  });

  it("settles (no hang) on the process error path after the ack: ambiguous post_ack", async () => {
    const client = new FakeRpcClient();
    client.terminate = "error";
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("post_ack");
  });

  it("classifies termination after an agent-visible event as ambiguous mid_stream", async () => {
    const client = new FakeRpcClient();
    client.events = [{ type: "agent_start" }, textEvent("partial")];
    client.terminate = "exit";
    const outcome = await askAgentClassified(TARGET, "hi", { clientFactory: factory(client) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("mid_stream");
  });

  it("NEGATIVE: a post-start termination whose detail mentions 'launch' is never launch_failure", async () => {
    const client = new FakeRpcClient();
    client.terminate = "error";
    const outcome = await askAgentClassified(TARGET, "hi", {
      clientFactory: (t) => {
        void t;
        return client;
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).not.toBe("launch_failure");
  });
});
