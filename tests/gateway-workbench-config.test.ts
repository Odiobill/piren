import { describe, expect, it, vi } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";
import { createNodeWorkbenchConfigReader } from "../src/workbench-config.js";

/**
 * VR-2 — gateway startup wiring for the optional vault-root `workbench.yml`
 * one-key contract: resolve EXACTLY ONCE before ConversationBroker
 * construction, pass the resolved milliseconds deadline into the broker,
 * emit only bounded non-secret warnings for malformed/out-of-range files,
 * and never read at all where no conversation broker can exist.
 */

import { join } from "node:path";

const TARGET = {
  command: process.execPath,
  args: [join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs")],
  cwd: process.cwd(),
  env: process.env,
};

async function startedServer(options: {
  vaultRoot?: string;
  runnableAgents?: string[];
  targetBuilder?: boolean;
  reader?: () => string | null;
}): Promise<GatewayServer> {
  const server = makeServer(options);
  await server.start();
  return server;
}

function makeServer(options: {
  vaultRoot?: string;
  runnableAgents?: string[];
  targetBuilder?: boolean;
  reader?: () => string | null;
}): GatewayServer {
  return new GatewayServer({
    target: TARGET,
    ...(options.vaultRoot !== undefined ? { vaultRoot: options.vaultRoot } : {}),
    ...(options.runnableAgents !== undefined ? { runnableAgents: options.runnableAgents } : {}),
    ...(options.targetBuilder === true
      ? { targetBuilder: async () => TARGET }
      : {}),
    ...(options.reader !== undefined ? { workbenchConfigReader: options.reader } : {}),
    workbenchWarn: () => {},
  });
}

describe("GatewayServer workbench.yml startup wiring (VR-2)", () => {
  it("reads workbench.yml exactly once before broker construction; absent resolves the 3_600_000 ms default with no warning", async () => {
    const reader = vi.fn(() => null);
    const server = await startedServer({ vaultRoot: "/tmp/v", runnableAgents: ["zai"], targetBuilder: true, reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(server.conversationRunTimeoutMs).toBe(3_600_000);
    await server.close();
  });

  it("a valid short configured deadline reaches the broker unchanged and emits no warning", async () => {
    const warns = vi.fn();
    const server = new GatewayServer({
      target: TARGET,
      vaultRoot: "/tmp/v",
      runnableAgents: ["zai"],
      targetBuilder: async () => TARGET,
      workbenchConfigReader: () => "conversation:\n  run_timeout_seconds: 45\n",
      workbenchWarn: warns,
    });
    await server.start();
    expect(server.conversationRunTimeoutMs).toBe(45_000);
    expect(warns).not.toHaveBeenCalled();
    await server.close();
  });

  it("malformed YAML uses the default and emits exactly one bounded non-secret warning", async () => {
    const warns = vi.fn();
    const yaml = 'token: "super-secret"\nconversation:\n  run_timeout_seconds: [unclosed\n';
    const server = new GatewayServer({
      target: TARGET,
      vaultRoot: "/tmp/v",
      runnableAgents: ["zai"],
      targetBuilder: async () => TARGET,
      workbenchConfigReader: () => yaml,
      workbenchWarn: warns,
    });
    await server.start();
    expect(server.conversationRunTimeoutMs).toBe(3_600_000);
    expect(warns).toHaveBeenCalledTimes(1);
    const message = String(warns.mock.calls[0]?.[0]);
    expect(message).toContain("workbench.yml");
    expect(message).toContain("malformed-yaml");
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain("/tmp/v");
    await server.close();
  });

  it("an out-of-range value uses the default and emits exactly one bounded warning naming the key path and category", async () => {
    const warns = vi.fn();
    const server = new GatewayServer({
      target: TARGET,
      vaultRoot: "/tmp/v",
      runnableAgents: ["zai"],
      targetBuilder: async () => TARGET,
      workbenchConfigReader: () => "conversation:\n  run_timeout_seconds: 99999\n",
      workbenchWarn: warns,
    });
    await server.start();
    expect(server.conversationRunTimeoutMs).toBe(3_600_000);
    expect(warns).toHaveBeenCalledTimes(1);
    const message = String(warns.mock.calls[0]?.[0]);
    expect(message).toContain("conversation.run_timeout_seconds");
    expect(message).toContain("out-of-range");
    expect(message).not.toContain("99999");
    await server.close();
  });

  it("never reads workbench.yml where no conversation broker can exist", async () => {
    const reader = vi.fn(() => null);
    // No vaultRoot/targetBuilder: no broker is constructed, so no read.
    const serverA = await startedServer({ runnableAgents: ["zai"], reader });
    expect(reader).not.toHaveBeenCalled();
    await serverA.close();
    // No runnable agents either: still no read.
    const readerB = vi.fn(() => null);
    const serverC = new GatewayServer({
      target: TARGET,
      vaultRoot: "/tmp/v",
      runnableAgents: [],
      workbenchConfigReader: readerB,
      workbenchWarn: () => {},
    });
    await serverC.start();
    expect(readerB).not.toHaveBeenCalled();
    await serverC.close();
  });

  it("the production node reader returns null for an absent file instead of throwing", () => {
    const reader = createNodeWorkbenchConfigReader("/tmp/definitely-absent-vr2-vault");
    expect(reader()).toBeNull();
  });
});
