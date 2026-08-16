import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import {
  createLocalServiceStatusReader,
  type ServiceObservationDeps,
  type ServiceStatusSnapshot,
} from "../src/service-observability.js";

/**
 * D2.2 — authenticated gateway service-observation read (accepted contract:
 * Projects/Piren/workbench-dashboard-service-observability-contract.md).
 *
 * The narrow read-only GET /api/services/status route returns exactly the
 * D2.1 ServiceStatusSnapshot contract (server-generated observedAt, manager,
 * fixed-order telegram/discord/scheduler targets) behind the existing /api/*
 * Bearer gate. The observation reader is an injected seam: these tests never
 * probe a live service manager, start a service, or require live Pi auth.
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

const SNAPSHOT: ServiceStatusSnapshot = {
  observedAt: "2026-08-16T12:00:00.000Z",
  manager: "systemd-user",
  targets: [
    { target: "telegram", state: "active" },
    { target: "discord", state: "inactive" },
    { target: "scheduler", state: "not-installed" },
  ],
};

describe("GET /api/services/status (D2.2)", () => {
  it("returns 200 with the exact bounded injected snapshot for a correct Bearer token", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => SNAPSHOT,
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Exactly the D2.1 contract: no envelope or diagnostic fields.
      expect(Object.keys(body)).toEqual(["observedAt", "manager", "targets"]);
      expect(body).toEqual(SNAPSHOT);
      // Fixed contract order: telegram, discord, scheduler; never gateway.
      const targets = body.targets as Array<{ target: string }>;
      expect(targets.map((t) => t.target)).toEqual(["telegram", "discord", "scheduler"]);
    } finally {
      await server.close();
    }
  });

  it("returns 401 for a missing token and never invokes the reader", async () => {
    let calls = 0;
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`);
      expect(res.status).toBe(401);
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("returns 401 for a wrong token and never invokes the reader", async () => {
    let calls = 0;
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("ignores every query selection attempt and invokes the reader with no arguments", async () => {
    const calls: unknown[][] = [];
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => {
        calls.push([]);
        return SNAPSHOT;
      },
    });
    try {
      const handle = await server.start();
      const query = "?target=gateway&manager=systemd&command=systemctl&path=/etc&timeout=1";
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status${query}`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Reader use stays fixed: exactly one zero-argument invocation.
      expect(calls).toEqual([[]]);
      // No gateway target, no echo of the attempted selection, no diagnostics.
      expect(body).toEqual(SNAPSHOT);
      expect(JSON.stringify(body)).not.toContain("gateway");
      expect(JSON.stringify(body)).not.toContain("systemctl");
    } finally {
      await server.close();
    }
  });

  it("accepts no body: a POST with a selection body is not the read route and never invokes the reader", async () => {
    let calls = 0;
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify({ target: "gateway", command: "systemctl restart" }),
      });
      expect(res.status).toBe(404);
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("passes a per-target unknown snapshot through unchanged (not a whole-snapshot failure)", async () => {
    const partial: ServiceStatusSnapshot = {
      observedAt: "2026-08-16T12:05:00.000Z",
      manager: "tmux-cron",
      targets: [
        { target: "telegram", state: "active" },
        { target: "discord", state: "unknown" },
        { target: "scheduler", state: "inactive" },
      ],
    };
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => partial,
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(partial);
    } finally {
      await server.close();
    }
  });

  it("returns a bounded non-diagnostic failure when the reader throws (never a fabricated snapshot)", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      authToken: "secret-token",
      serviceStatusReader: async () => {
        throw new Error("systemctl failed: /usr/bin/systemctl exited 1 with secret-detail");
      },
    });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      // Fixed bounded body: no raw error text, paths, commands, or state claim.
      expect(body).toEqual({ error: "service observation unavailable" });
      expect(JSON.stringify(body)).not.toContain("systemctl");
      expect(JSON.stringify(body)).not.toContain("secret-detail");
    } finally {
      await server.close();
    }
  });

  it("returns the same bounded failure when no reader is configured (never invents manager/target state)", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), authToken: "secret-token" });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/services/status`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "service observation unavailable" });
    } finally {
      await server.close();
    }
  });
});

describe("CLI production wiring (D2.2)", () => {
  function fakeDeps(overrides: Partial<ServiceObservationDeps> = {}): ServiceObservationDeps {
    return {
      hasSystemdUser: async () => false,
      hasTmux: async () => false,
      hasCrontab: async () => false,
      run: async () => ({ exitCode: null, signal: null, stdout: "" }),
      artifactExists: async () => false,
      now: () => new Date("2026-08-16T12:10:00.000Z"),
      timeoutAfter: () => new Promise<never>(() => {}),
      ...overrides,
    };
  }

  it("composes the D2.1 evaluator over the injected local-deps seam (no live manager probe)", async () => {
    const reader = createLocalServiceStatusReader(fakeDeps());
    const snapshot = await reader();
    expect(snapshot).toEqual({
      observedAt: "2026-08-16T12:10:00.000Z",
      manager: "unavailable",
      targets: [
        { target: "telegram", state: "unavailable" },
        { target: "discord", state: "unavailable" },
        { target: "scheduler", state: "unavailable" },
      ],
    });
  });

  it("returns a reader for the zero-argument production call without starting a service or probing", () => {
    // The CLI calls createLocalServiceStatusReader() with no arguments, which
    // selects the fixed local observation seams. Constructing the reader must
    // not probe anything; we intentionally do not invoke it against the live
    // host in a unit test.
    const reader = createLocalServiceStatusReader();
    expect(typeof reader).toBe("function");
  });

  it("the CLI gateway command wires the D2.1 local reader into GatewayServer", async () => {
    // Static pin on the thin CLI dispatch: the production path supplies the
    // D2.1 local reader seam. (Helper behavior is proven by the tests above.)
    const cliSource = await readFile(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(cliSource).toContain('import { createLocalServiceStatusReader } from "./service-observability.js";');
    expect(cliSource).toContain("serviceStatusReader: createLocalServiceStatusReader(),");
  });
});
