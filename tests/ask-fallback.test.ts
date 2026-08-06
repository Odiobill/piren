import { describe, expect, it } from "vitest";
import { askAgent, askAgentClassified, type PiRpcClientLike } from "../src/ask.js";
import type { GatewayFallbackPolicy } from "../src/model-fallback-gateway.js";
import type { RpcEvent, RpcSpawnTarget } from "../src/gateway-rpc.js";

// TB5 — bounded `piren ask` same-live-client model fallback (design §8 TB5,
// §4.2/§4.3, §5, §6.5). Fake-client tests at the smallest seam: no live Pi
// auth, no filesystem. The resolved agent-local policy is injected; the ask
// core never reads YAML/files or derives config from RPC args.

const TARGET: RpcSpawnTarget = {
  command: "fake-pi",
  args: [],
  cwd: "/tmp",
  env: {},
};

const POLICY: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

function policyWith(models: string[], autoSwitch = true): GatewayFallbackPolicy {
  return {
    primaryModelId: "kimi-coding/k3",
    fallback: { ok: true, present: true, config: { autoSwitch, models } },
  };
}

function errorRecord(): Record<string, unknown> {
  return { role: "assistant", content: [], stopReason: "error", errorMessage: "provider error (401)" };
}

/** Settled zero-side-effect provider-error script (eligible). */
function providerErrorEvents(retryExhausted: boolean): RpcEvent[] {
  const record = errorRecord();
  const events: RpcEvent[] = [{ type: "agent_start" }];
  if (retryExhausted) {
    events.push(
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "529 overloaded" },
      { type: "auto_retry_end", attempt: 3, maxAttempts: 3, success: false, finalError: "529 overloaded" },
    );
  }
  events.push(
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  );
  return events;
}

/** Settled but contaminated provider-error script (text delta before error). */
function contaminatedEvents(): RpcEvent[] {
  const record = errorRecord();
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial" } },
    { type: "message_start", message: record },
    { type: "message_end", message: record },
    { type: "turn_end", message: { ...record, toolResults: [] } },
    { type: "agent_end", messages: [record], willRetry: false },
    { type: "agent_settled" },
  ];
}

/** Normal completed run with one text delta. */
function normalEvents(delta: string): RpcEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

class FakeAskClient implements PiRpcClientLike {
  startError?: Error;
  /** Event scripts consumed in order, one per prompt. */
  scripts: RpcEvent[][] = [];
  promptMessages: string[] = [];
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  /** Full provider/modelId ids whose set_model must reject (unavailable). */
  rejectSetModelIds: string[] = [];
  terminate = false;
  stopCalled = false;
  hasSetModel = true;

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
    const script = this.scripts.shift() ?? [];
    for (const event of script) {
      for (const listener of [...this.eventListeners]) listener(event);
    }
    if (this.terminate) {
      for (const listener of [...this.exitListeners]) listener();
    }
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    this.setModelCalls.push({ provider, modelId });
    if (!this.hasSetModel) {
      throw new Error("RPC client does not support set_model");
    }
    if (this.rejectSetModelIds.includes(`${provider}/${modelId}`)) {
      throw new Error("model not found");
    }
    return { provider, modelId };
  }
}

function factory(client: FakeAskClient): (target: RpcSpawnTarget) => PiRpcClientLike {
  return () => client;
}

function advisoryCollector(): { lines: string[]; onAdvisory: (line: string) => void } {
  const lines: string[] = [];
  return { lines, onAdvisory: (line) => lines.push(line) };
}

describe("askAgentClassified TB5 fallback", () => {
  it("eligible settled provider_error_other sets the next model and handoff-reprompts ONCE on the same client", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const advisory = advisoryCollector();
    const tokens: string[] = [];

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
      onAdvisory: advisory.onAdvisory,
      onToken: (t) => tokens.push(t),
    });

    expect(outcome).toEqual({ ok: true, text: "Fbk openai/gpt-4.1" });
    // Same live client: exactly one set_model + one handoff re-prompt.
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(client.promptMessages).toHaveLength(2);
    expect(client.promptMessages[0]).toBe("original task");
    expect(client.promptMessages[1]).toContain("[model fallback:");
    expect(client.promptMessages[1]).toContain("original task");
    expect(tokens.join("")).toBe("Fbk openai/gpt-4.1");
    expect(advisory.lines).toEqual(["[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]"]);
    expect(client.stopCalled).toBe(true);
  });

  it("eligible transient-exhausted category falls back with its honest category", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(true), normalEvents("Fbk openai/gpt-4.1")];
    const advisory = advisoryCollector();

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
      onAdvisory: advisory.onAdvisory,
    });

    expect(outcome).toEqual({ ok: true, text: "Fbk openai/gpt-4.1" });
    expect(advisory.lines).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_transient_exhausted) → openai/gpt-4.1]",
    ]);
    expect(client.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
  });

  it("ordered multi-fallback at-most-once: rejected set_model skips WITHOUT re-prompting the failed model", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    client.rejectSetModelIds = ["bogus/x"];
    const advisory = advisoryCollector();

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: policyWith(["bogus/x", "openai/gpt-4.1"]),
      onAdvisory: advisory.onAdvisory,
    });

    expect(outcome).toEqual({ ok: true, text: "Fbk openai/gpt-4.1" });
    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "openai", modelId: "gpt-4.1" },
    ]);
    // Exactly two prompts: the original plus ONE handoff re-prompt on the
    // successful fallback. The rejected model never re-ran the request.
    expect(client.promptMessages).toHaveLength(2);
    expect(client.promptMessages[1]).toContain("[model fallback:");
    expect(advisory.lines).toEqual([
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → bogus/x]",
      "[model fallback: bogus/x unavailable; skipping]",
      "[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]",
    ]);
  });

  it("typed terminal exhaustion: no loop, safe category/model evidence only", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x", "bogus/y"];
    const advisory = advisoryCollector();

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: policyWith(["bogus/x", "bogus/y"]),
      onAdvisory: advisory.onAdvisory,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("exhausted");
    expect(outcome.failure.exhaustion).toEqual({
      category: "provider_error_other",
      lastModelId: "kimi-coding/k3",
      attemptedCount: 2,
    });
    // No loop: the original prompt ran exactly once, never re-promoted.
    expect(client.promptMessages).toEqual(["original task"]);
    expect(client.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "bogus", modelId: "y" },
    ]);
    // The detail and evidence never carry raw provider error text.
    expect(outcome.failure.detail).toContain("kimi-coding/k3");
    expect(outcome.failure.detail).not.toContain("401");
    expect(outcome.failure.detail).not.toContain("provider error");
    expect(JSON.stringify(outcome.failure)).not.toMatch(/api[_-]?key|secret|token/i);
    expect(client.stopCalled).toBe(true);
  });

  it("a client without setModel fails closed as an unavailable skip then exhaustion", async () => {
    const client = new FakeAskClient();
    client.hasSetModel = false;
    client.scripts = [providerErrorEvents(false)];

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("exhausted");
    expect(outcome.failure.exhaustion?.attemptedCount).toBe(1);
    // Never re-ran the original on a client that cannot switch models.
    expect(client.promptMessages).toEqual(["original task"]);
  });

  it("contaminated run (text/tool/UI side effects) never falls back; existing ok-with-text contract", async () => {
    const client = new FakeAskClient();
    client.scripts = [contaminatedEvents()];
    const advisory = advisoryCollector();

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
      onAdvisory: advisory.onAdvisory,
    });

    expect(outcome).toEqual({ ok: true, text: "Partial" });
    expect(client.setModelCalls).toEqual([]);
    expect(client.promptMessages).toEqual(["original task"]);
    expect(advisory.lines).toEqual([]);
  });

  it("a run that never settles (no agent_settled) terminates conservative: ambiguous, no fallback", async () => {
    const client = new FakeAskClient();
    client.scripts = [[{ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false }]];
    client.terminate = true;

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("mid_stream");
    expect(client.setModelCalls).toEqual([]);
  });

  it("prompt rejection stays ambiguous at prompt_handoff with no fallback", async () => {
    const client = new FakeAskClient();
    client.scripts = [];
    const original = askAgentClassified;
    void original;

    const outcome = await askAgentClassified(TARGET, "fail please", {
      clientFactory: () => {
        const rejecting = new FakeAskClient();
        rejecting.scripts = [];
        // A prompt rejection is simulated by throwing inside prompt().
        rejecting.prompt = async () => {
          throw new Error("prompt rejected: another prompt is already running");
        };
        return rejecting;
      },
      fallbackPolicy: POLICY,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("prompt_handoff");
  });

  it("start rejection stays launch_failure at start_rejection with no fallback", async () => {
    const client = new FakeAskClient();
    client.startError = new Error("Failed to spawn agent: ENOENT pi binary");

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("launch_failure");
    expect(outcome.failure.milestone).toBe("start_rejection");
    expect(client.promptMessages).toEqual([]);
    expect(client.setModelCalls).toEqual([]);
  });

  it("client termination after an event is ambiguous mid_stream with no fallback", async () => {
    const client = new FakeAskClient();
    client.scripts = [[{ type: "agent_start" }, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }]];
    client.terminate = true;

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("ambiguous");
    expect(outcome.failure.milestone).toBe("mid_stream");
    expect(client.setModelCalls).toEqual([]);
  });

  it("absent policy stays inert: existing single-run contract, no advisory, no set_model", async () => {
    const client = new FakeAskClient();
    client.scripts = [normalEvents("Hello")];
    const advisory = advisoryCollector();

    const outcome = await askAgentClassified(TARGET, "hi", {
      clientFactory: factory(client),
      onAdvisory: advisory.onAdvisory,
    });

    expect(outcome).toEqual({ ok: true, text: "Hello" });
    expect(client.setModelCalls).toEqual([]);
    expect(client.promptMessages).toEqual(["hi"]);
    expect(advisory.lines).toEqual([]);
  });

  it("malformed policy stays inert at runtime", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false)];
    const malformed: GatewayFallbackPolicy = {
      primaryModelId: "kimi-coding/k3",
      fallback: { ok: false, reason: "model.fallback.models must be an array." },
    };

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: malformed,
    });

    expect(outcome).toEqual({ ok: true, text: "" });
    expect(client.setModelCalls).toEqual([]);
    expect(client.promptMessages).toEqual(["original task"]);
  });

  it("auto_switch:false stays inert with the declared list unused at runtime", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false)];

    const outcome = await askAgentClassified(TARGET, "original task", {
      clientFactory: factory(client),
      fallbackPolicy: policyWith(["openai/gpt-4.1"], false),
    });

    expect(outcome).toEqual({ ok: true, text: "" });
    expect(client.setModelCalls).toEqual([]);
    expect(client.promptMessages).toEqual(["original task"]);
  });

  it("handoff preserves a verbatim multiline original request and never exposes provider error text", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const original = "Read team/dipu/inbox/x.md\n\nThen:\n1. Summarize.\n2. Do not repeat side effects.";

    const outcome = await askAgentClassified(TARGET, original, {
      clientFactory: factory(client),
      fallbackPolicy: POLICY,
    });

    expect(outcome).toEqual({ ok: true, text: "Fbk openai/gpt-4.1" });
    const handoff = client.promptMessages[1] ?? "";
    expect(handoff.endsWith(original)).toBe(true);
    // The fixed §4.3 header mentions "a provider error" by design; the raw
    // errorMessage content and status text must never leak.
    expect(handoff).not.toContain("provider error (401)");
    expect(handoff).not.toContain("401");
    expect(handoff).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it("askAgent wrapper surfaces typed exhaustion as a safe thrown error", async () => {
    const client = new FakeAskClient();
    client.scripts = [providerErrorEvents(false)];
    client.rejectSetModelIds = ["bogus/x"];

    await expect(
      askAgent(TARGET, "original task", undefined, {
        clientFactory: factory(client),
        fallbackPolicy: policyWith(["bogus/x"]),
      }),
    ).rejects.toThrow(/model fallback exhausted after 1 attempt\(s\) on kimi-coding\/k3 \(provider_error_other\)/);
    expect(client.promptMessages).toEqual(["original task"]);
  });
});
