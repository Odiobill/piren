import { describe, expect, it } from "vitest";
import {
  renderTransportFallbackNotice,
  runTransportFallback,
  type TransportFallbackNotice,
} from "../src/model-fallback-transport.js";
import type { GatewayFallbackPolicy } from "../src/model-fallback-gateway.js";
import type { RpcEvent } from "../src/gateway-rpc.js";

// TB7 pure transport fallback core (design §8 TB7, §4.2/§4.3, §5, §6.4, §7).
// Same-live-client rotation over an injected run/setModel seam: the transport
// owns the platform adaptation (clients, APIs, chunking); this core decides
// and streams bounded non-secret notices.

const POLICY: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

function policyWith(models: string[], autoSwitch = true): GatewayFallbackPolicy {
  return { primaryModelId: "kimi-coding/k3", fallback: { ok: true, present: true, config: { autoSwitch, models } } };
}

const NO_PRIMARY: GatewayFallbackPolicy = {
  primaryModelId: null,
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/gpt-4.1"] } },
};

const MALFORMED: GatewayFallbackPolicy = {
  primaryModelId: "kimi-coding/k3",
  fallback: { ok: false, reason: "model.fallback.models must be an array." },
};

function errorRecord(): Record<string, unknown> {
  return { role: "assistant", content: [], stopReason: "error", errorMessage: "provider error (401)" };
}

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

function normalEvents(delta: string): RpcEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

class FakeSeam {
  scripts: RpcEvent[][] = [];
  prompts: string[] = [];
  setModelCalls: Array<{ provider: string; modelId: string }> = [];
  rejectSetModelIds: string[] = [];
  hasSetModel = true;
  /** Gate: setModel awaits this before resolving/rejecting. */
  setModelGate: Promise<void> | null = null;
  aborted = false;
  notices: TransportFallbackNotice[] = [];
  runError: Error | null = null;

  async run(prompt: string): Promise<RpcEvent[]> {
    this.prompts.push(prompt);
    if (this.runError !== null) throw this.runError;
    return this.scripts.shift() ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    if (this.setModelGate !== null) await this.setModelGate;
    this.setModelCalls.push({ provider, modelId });
    if (!this.hasSetModel) throw new Error("RPC client does not support set_model");
    if (this.rejectSetModelIds.includes(`${provider}/${modelId}`)) throw new Error("model not found");
    return { provider, modelId };
  }
}

function runWith(seam: FakeSeam, policy: GatewayFallbackPolicy, originalPrompt = "original task") {
  return runTransportFallback({
    originalPrompt,
    policy,
    run: (p) => seam.run(p),
    setModel: (provider, modelId) => seam.setModel(provider, modelId),
    onNotice: (notice) => {
      seam.notices.push(notice);
    },
    isAborted: () => seam.aborted,
  });
}

describe("runTransportFallback", () => {
  it("eligible provider_error_other performs one same-client switch + handoff re-prompt and streams an attempt notice", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];

    const result = await runWith(seam, POLICY, "Please review the vault.");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(seam.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(seam.prompts).toHaveLength(2);
    expect(seam.prompts[0]).toBe("Please review the vault.");
    expect(seam.prompts[1]).toContain("[model fallback:");
    expect(seam.prompts[1]).toContain("Please review the vault.");
    expect(seam.notices).toEqual([
      { kind: "attempt", from: "kimi-coding/k3", to: "openai/gpt-4.1", category: "provider_error_other", attempt: 1 },
    ]);
  });

  it("eligible transient-exhausted streams its honest category", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(true), normalEvents("Fbk openai/gpt-4.1")];

    const result = await runWith(seam, POLICY);

    expect(result.status).toBe("completed");
    expect(seam.notices).toEqual([
      { kind: "attempt", from: "kimi-coding/k3", to: "openai/gpt-4.1", category: "provider_error_transient_exhausted", attempt: 1 },
    ]);
  });

  it("declaration-order multi-fallback: rejected set_model is an unavailable skip with no original replay", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    seam.rejectSetModelIds = ["bogus/x"];

    const result = await runWith(seam, policyWith(["bogus/x", "openai/gpt-4.1"]));

    expect(result.status).toBe("completed");
    expect(seam.setModelCalls).toEqual([
      { provider: "bogus", modelId: "x" },
      { provider: "openai", modelId: "gpt-4.1" },
    ]);
    // Exactly two runs: the original plus ONE handoff re-prompt on the
    // successful fallback; the rejected model never re-ran the request.
    expect(seam.prompts).toHaveLength(2);
    expect(seam.prompts[1]).toContain("[model fallback:");
    expect(seam.notices).toEqual([
      { kind: "attempt", from: "kimi-coding/k3", to: "bogus/x", category: "provider_error_other", attempt: 1 },
      { kind: "unavailable", modelId: "bogus/x", attempt: 1 },
      { kind: "attempt", from: "kimi-coding/k3", to: "openai/gpt-4.1", category: "provider_error_other", attempt: 2 },
    ]);
  });

  it("terminal exhaustion streams the exhausted notice, never loops, and carries safe evidence", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false)];
    seam.rejectSetModelIds = ["bogus/x", "bogus/y"];

    const result = await runWith(seam, policyWith(["bogus/x", "bogus/y"]));

    expect(result.status).toBe("exhausted");
    if (result.status !== "exhausted") return;
    expect(result.attemptedCount).toBe(2);
    expect(result.lastModelId).toBe("kimi-coding/k3");
    // No loop: the original ran exactly once, never re-promoted.
    expect(seam.prompts).toEqual(["original task"]);
    expect(seam.notices[seam.notices.length - 1]).toEqual({
      kind: "exhausted",
      lastModelId: "kimi-coding/k3",
      category: "provider_error_other",
      attemptedCount: 2,
    });
  });

  it("inert absent/malformed/disabled/no-primary policies run once with no notices", async () => {
    for (const policy of [NO_PRIMARY, MALFORMED, policyWith(["openai/gpt-4.1"], false)]) {
      const seam = new FakeSeam();
      seam.scripts = [normalEvents("Hello")];
      const result = await runWith(seam, policy);
      expect(result.status).toBe("completed");
      expect(seam.setModelCalls).toEqual([]);
      expect(seam.prompts).toEqual(["original task"]);
      expect(seam.notices).toEqual([]);
    }
  });

  it("contaminated run never falls back (existing completed semantics, no notices)", async () => {
    const seam = new FakeSeam();
    seam.scripts = [contaminatedEvents()];
    const result = await runWith(seam, POLICY);
    expect(result.status).toBe("completed");
    expect(seam.setModelCalls).toEqual([]);
    expect(seam.prompts).toEqual(["original task"]);
    expect(seam.notices).toEqual([]);
  });

  it("a run rejection (timeout/prompt rejection) propagates with no fallback", async () => {
    const seam = new FakeSeam();
    seam.runError = new Error("Timed out waiting for agent_settled.");
    await expect(runWith(seam, POLICY)).rejects.toThrow("Timed out");
    expect(seam.setModelCalls).toEqual([]);
    expect(seam.notices).toEqual([]);
  });

  it("abort before the first run (e.g. during policy load) never issues a run or a re-prompt", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false)];
    seam.aborted = true; // abort already landed before the runner started
    const result = await runWith(seam, POLICY);
    expect(result.status).toBe("completed");
    expect(seam.setModelCalls).toEqual([]);
    expect(seam.prompts).toEqual([]);
    expect(seam.notices).toEqual([]);
  });

  it("an abort landing while the first run is in flight prevents any switch or re-prompt", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false)];
    // The abort lands once the run is in flight (client.abort() resolves the
    // in-flight prompt with abort events); the settled outcome stays terminal.
    const originalRun = seam.run.bind(seam);
    seam.run = async (prompt: string) => {
      const events = await originalRun(prompt);
      seam.aborted = true;
      return events;
    };
    const result = await runWith(seam, POLICY);
    expect(result.status).toBe("completed");
    expect(seam.setModelCalls).toEqual([]);
    expect(seam.prompts).toEqual(["original task"]);
    expect(seam.notices).toEqual([]);
  });

  it("abort landing during a delayed set_model cancels the pending handoff re-prompt", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false)];
    let releaseGate!: () => void;
    seam.setModelGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const running = runWith(seam, POLICY);
    // Let the runner reach the gated setModel, then abort (steward intent).
    await new Promise((resolve) => setTimeout(resolve, 20));
    seam.aborted = true;
    releaseGate();
    const result = await running;
    expect(result.status).toBe("completed");
    // The attempt notice was streamed, but NO handoff re-prompt was issued.
    expect(seam.setModelCalls).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
    expect(seam.prompts).toEqual(["original task"]);
  });

  it("handoff preserves a verbatim multiline original request", async () => {
    const seam = new FakeSeam();
    seam.scripts = [providerErrorEvents(false), normalEvents("Fbk openai/gpt-4.1")];
    const original = "Line one\n\nLine two.\n1. First.\n2. Second.";
    const result = await runWith(seam, POLICY, original);
    expect(result.status).toBe("completed");
    const handoff = seam.prompts[1] ?? "";
    expect(handoff.endsWith(original)).toBe(true);
    expect(handoff).not.toContain("provider error (401)");
    expect(handoff).not.toContain("401");
  });
});

describe("renderTransportFallbackNotice", () => {
  it("renders the exact bounded advisory formats", () => {
    expect(
      renderTransportFallbackNotice({ kind: "attempt", from: "kimi-coding/k3", to: "openai/gpt-4.1", category: "provider_error_other", attempt: 1 }),
    ).toBe("[model fallback: kimi-coding/k3 failed (provider_error_other) → openai/gpt-4.1]");
    expect(renderTransportFallbackNotice({ kind: "unavailable", modelId: "bogus/x", attempt: 1 })).toBe(
      "[model fallback: bogus/x unavailable; skipping]",
    );
    expect(
      renderTransportFallbackNotice({ kind: "exhausted", lastModelId: "kimi-coding/k3", category: "provider_error_other", attemptedCount: 2 }),
    ).toBe("[model fallback: exhausted after 2 attempt(s) on kimi-coding/k3 (provider_error_other)]");
  });

  it("never carries raw provider error text or secrets", () => {
    const attempts: TransportFallbackNotice[] = [
      { kind: "attempt", from: "kimi-coding/k3", to: "openai/gpt-4.1", category: "provider_error_other", attempt: 1 },
      { kind: "unavailable", modelId: "bogus/x", attempt: 1 },
      { kind: "exhausted", lastModelId: "kimi-coding/k3", category: "provider_error_other", attemptedCount: 2 },
    ];
    for (const notice of attempts) {
      const rendered = renderTransportFallbackNotice(notice);
      expect(rendered).not.toContain("401");
      expect(rendered).not.toContain("provider error (401)");
      expect(rendered).not.toMatch(/api[_-]?key|secret|token|session|\.config/i);
    }
  });
});
