import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import type { GatewayFallbackPolicy } from "../src/model-fallback-gateway.js";

// TB4 — gateway chat/OpenAI same-client model fallback integration against the
// fake Pi process (no live auth). Covers: eligible provider-error categories
// fall back with bounded model_fallback evidence; contaminated / non-settled /
// prompt-rejected / aborted paths do not; ordered at-most-once rotation with
// set_model rejection skip and distinct terminal exhaustion; explicit steward
// model selection disables fallback (and re-enables via autoFallback:true);
// OpenAI non-streaming/streaming keep their exact schemas without leaking a
// Piren SSE event; absent/disabled/malformed config stays inert.

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

interface SseFrame {
  event: string;
  data: string;
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (event) frames.push({ event, data });
  }
  return frames;
}

function fallbackPolicy(overrides?: Partial<GatewayFallbackPolicy>): GatewayFallbackPolicy {
  return {
    primaryModelId: "anthropic/claude-sonnet-4-20250514",
    fallback: {
      ok: true,
      present: true,
      config: { autoSwitch: true, models: ["openai/gpt-4.1"] },
    },
    ...overrides,
  };
}

function loader(policy: GatewayFallbackPolicy) {
  return async () => policy;
}

function framesByEvent(frames: SseFrame[], event: string): SseFrame[] {
  return frames.filter((frame) => frame.event === event);
}

function tokenText(frames: SseFrame[]): string {
  return framesByEvent(frames, "token")
    .map((frame) => (JSON.parse(frame.data) as { text: string }).text)
    .join("");
}

const POLICY = fallbackPolicy();
const MULTI = fallbackPolicy({
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["bogus/x", "openai/gpt-4.1"] } },
});
const ALL_BOGUS = fallbackPolicy({
  fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["bogus/x", "bogus/y"] } },
});

describe("TB4 gateway chat SSE model fallback", () => {
  it("settled zero-side-effect provider_error_other falls back on the same client with bounded evidence", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      expect(start.status).toBe(200);
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      // Exactly one bounded model_fallback before the replacement run.
      const fallbacks = framesByEvent(frames, "model_fallback");
      expect(fallbacks).toHaveLength(1);
      expect(JSON.parse(fallbacks[0]?.data ?? "{}")).toEqual({
        kind: "model_fallback",
        from: "anthropic/claude-sonnet-4-20250514",
        to: "openai/gpt-4.1",
        category: "provider_error_other",
        attempt: 1,
        exhausted: false,
      });

      // Internal set_model evidence: model_changed reflects the fallback.
      const changed = framesByEvent(frames, "model_changed");
      expect(changed).toHaveLength(1);
      expect((JSON.parse(changed[0]?.data ?? "{}") as { model: unknown }).model).toEqual({
        provider: "openai",
        id: "gpt-4.1",
      });

      // The fallback response ran on the switched model (same live client),
      // and exactly one terminal done closes the stream.
      expect(tokenText(frames)).toBe("Fbk openai/gpt-4.1");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
      expect(frames[frames.length - 1]?.event).toBe("done");
      expect(framesByEvent(frames, "error")).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("transient-exhausted category falls back with its honest category", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackretry please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      const fallbacks = framesByEvent(frames, "model_fallback");
      expect(fallbacks).toHaveLength(1);
      expect(JSON.parse(fallbacks[0]?.data ?? "{}")).toMatchObject({
        category: "provider_error_transient_exhausted",
        exhausted: false,
        to: "openai/gpt-4.1",
      });
      expect(tokenText(frames)).toBe("Fbk openai/gpt-4.1");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("contaminated provider-error run does not fall back", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackcontam please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "model_changed")).toHaveLength(0);
      expect(tokenText(frames)).toBe("Partial");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("prompt rejection retains existing behavior: error event, no fallback, no done", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fail please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "error")).toHaveLength(1);
      expect(framesByEvent(frames, "done")).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("abort during an active run cancels remaining attempts and never falls back", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hang please" }),
      });
      expect(start.status).toBe(200);
      const { stream_id } = (await start.json()) as { stream_id: string };

      const abort = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/abort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(abort.status).toBe(200);

      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());
      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("ordered at-most-once multi-fallback rotation skips a rejected set_model and proceeds", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(MULTI) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      const fallbacks = framesByEvent(frames, "model_fallback").map((frame) => JSON.parse(frame.data));
      expect(fallbacks).toEqual([
        {
          kind: "model_fallback",
          from: "anthropic/claude-sonnet-4-20250514",
          to: "bogus/x",
          category: "provider_error_other",
          attempt: 1,
          exhausted: false,
        },
        {
          kind: "model_fallback",
          from: "anthropic/claude-sonnet-4-20250514",
          to: "bogus/x",
          category: "unavailable",
          attempt: 1,
          exhausted: false,
        },
        {
          kind: "model_fallback",
          from: "anthropic/claude-sonnet-4-20250514",
          to: "openai/gpt-4.1",
          category: "provider_error_other",
          attempt: 2,
          exhausted: false,
        },
      ]);
      // The rejected set_model never changed the model; only the successful
      // switch produced model_changed evidence.
      expect(framesByEvent(frames, "model_changed")).toHaveLength(1);
      expect(tokenText(frames)).toBe("Fbk openai/gpt-4.1");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("terminal exhaustion is a distinct exhausted event and never loops", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(ALL_BOGUS) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      const fallbacks = framesByEvent(frames, "model_fallback").map((frame) => JSON.parse(frame.data));
      expect(fallbacks).toEqual([
        { kind: "model_fallback", from: "anthropic/claude-sonnet-4-20250514", to: "bogus/x", category: "provider_error_other", attempt: 1, exhausted: false },
        { kind: "model_fallback", from: "anthropic/claude-sonnet-4-20250514", to: "bogus/x", category: "unavailable", attempt: 1, exhausted: false },
        { kind: "model_fallback", from: "anthropic/claude-sonnet-4-20250514", to: "bogus/y", category: "provider_error_other", attempt: 2, exhausted: false },
        { kind: "model_fallback", from: "anthropic/claude-sonnet-4-20250514", to: "bogus/y", category: "unavailable", attempt: 2, exhausted: false },
        { kind: "model_fallback", from: "anthropic/claude-sonnet-4-20250514", to: "", category: "provider_error_other", attempt: 2, exhausted: true },
      ]);
      // No fallback text ever arrived; exactly one terminal done.
      expect(tokenText(frames)).toBe("");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("explicit steward model selection disables automatic fallback for the session", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const setModel = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", modelId: "gpt-4.1" }),
      });
      expect(setModel.status).toBe(200);

      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(tokenText(frames)).toBe("");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("explicit selection re-enables fallback only via autoFallback:true on the same route", async () => {
    // The explicit selection sets the session model to openai/gpt-4.1, so the
    // fallback list must be disjoint from it (rotation never re-selects the
    // current model).
    const reenablePolicy = fallbackPolicy({
      fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openrouter/kimi-k3"] } },
    });
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(reenablePolicy) });
    try {
      const handle = await server.start();
      const disable = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", modelId: "gpt-4.1" }),
      });
      expect(disable.status).toBe(200);

      // Without autoFallback:true the session stays explicit (no fallback).
      const startNo = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const noId = ((await startNo.json()) as { stream_id: string }).stream_id;
      const streamNo = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${noId}`);
      const framesNo = parseSse(await streamNo.text());
      expect(framesByEvent(framesNo, "model_fallback")).toHaveLength(0);

      // Explicit opt-in re-enable on the same route.
      const enable = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", modelId: "gpt-4.1", autoFallback: true }),
      });
      expect(enable.status).toBe(200);

      const startYes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const yesId = ((await startYes.json()) as { stream_id: string }).stream_id;
      const streamYes = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${yesId}`);
      const framesYes = parseSse(await streamYes.text());
      expect(framesByEvent(framesYes, "model_fallback")).toHaveLength(1);
      expect(tokenText(framesYes)).toBe("Fbk openrouter/kimi-k3");
    } finally {
      await server.close();
    }
  });

  it("a fallback policy without a configured primary model stays inert fail-closed", async () => {
    const noPrimary = fallbackPolicy({ primaryModelId: null });
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(noPrimary) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());

      // Without a primary identity, the server cannot prove that a candidate
      // differs from the just-failed Pi model; it must never replay it.
      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "model_changed")).toHaveLength(0);
      expect(tokenText(frames)).toBe("");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("absent fallback config stays inert with the existing single-run behavior", async () => {
    // No fallbackPolicyLoader and no vaultRoot: the default loader resolves
    // an absent policy (inert).
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());
      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "model_changed")).toHaveLength(0);
      expect(tokenText(frames)).toBe("");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("auto_switch:false keeps the declared list inert at runtime", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      fallbackPolicyLoader: loader(
        fallbackPolicy({
          fallback: { ok: true, present: true, config: { autoSwitch: false, models: ["openai/gpt-4.1"] } },
        }),
      ),
    });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());
      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("malformed fallback config stays inert at runtime", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      fallbackPolicyLoader: loader({ primaryModelId: "a/b", fallback: { ok: false, reason: "model.fallback.models must be an array." } }),
    });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());
      expect(framesByEvent(frames, "model_fallback")).toHaveLength(0);
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("a rejected set_model skips directly to the next fallback without re-running the failed model", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(MULTI) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const frames = parseSse(await stream.text());
      expect(tokenText(frames)).toBe("Fbk openai/gpt-4.1");
      expect(framesByEvent(frames, "done")).toHaveLength(1);

      // Design §5.1/§7: a rejected set_model records the skip and tries the
      // NEXT configured fallback directly. Exactly two prompt commands may
      // reach the live client: the initial run plus the single handoff
      // re-prompt. An extra prompt would mean the request was re-run on the
      // just-failed primary between fallback attempts.
      const state = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/state`);
      const body = (await state.json()) as { messageCount?: number };
      expect(body.messageCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("abort during the set_model exchange cancels the pending fallback re-prompt", async () => {
    const slowPolicy = fallbackPolicy({
      fallback: { ok: true, present: true, config: { autoSwitch: true, models: ["openai/slowmo"] } },
    });
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(slowPolicy) });
    try {
      const handle = await server.start();
      const start = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "fallbackerr please" }),
      });
      const { stream_id } = (await start.json()) as { stream_id: string };
      const stream = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/stream?stream_id=${stream_id}`);
      const streamBody = stream.body;
      if (!streamBody) throw new Error("missing SSE body");

      // Read the live stream until the model_fallback notice proves the
      // set_model exchange is in flight (the fake delays the slowmo ack by
      // 250ms), then land the steward abort inside that window.
      const reader = streamBody.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("model_fallback")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toContain("model_fallback");

      const abort = await fetch(`http://${handle.hostname}:${handle.port}/api/chat/abort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(abort.status).toBe(200);

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      const frames = parseSse(text);
      // Design §5.6: steward intent wins. Even though the delayed set_model
      // eventually succeeded, the handoff re-prompt must never run.
      expect(tokenText(frames)).toBe("");
      expect(framesByEvent(frames, "done")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe("TB4 OpenAI-compatible route model fallback", () => {
  it("non-streaming returns fallback assistant content with the existing chat.completion schema", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "piren/default",
          messages: [{ role: "user", content: "fallbackerr please" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        object: string;
        model: string;
        choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
      };
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe("piren/default");
      expect(body.choices).toEqual([
        { index: 0, message: { role: "assistant", content: "Fbk openai/gpt-4.1" }, finish_reason: "stop" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("streaming falls back and stays pure OpenAI chunks + [DONE] with no Piren SSE leak", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), fallbackPolicyLoader: loader(POLICY) });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "piren/default",
          stream: true,
          messages: [{ role: "user", content: "fallbackerr please" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const text = await res.text();

      // No Piren-specific SSE event may leak into the OpenAI stream.
      expect(text).not.toContain("model_fallback");
      expect(text).not.toContain("event: ");

      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));
      expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
      const chunks = dataLines
        .slice(0, -1)
        .map((line) => JSON.parse(line) as { object: string; choices: Array<{ delta: { content?: string } }> });
      expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
      expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")).toBe("Fbk openai/gpt-4.1");
    } finally {
      await server.close();
    }
  });
});
