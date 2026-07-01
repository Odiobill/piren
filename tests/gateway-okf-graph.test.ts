import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("GET /api/vault/graph", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    const tmp = join(process.cwd(), "tests", "fixtures", ".vault-graph-route-test");
    await rm(tmp, { recursive: true, force: true });
    await mkdir(join(tmp, "wiki", "concepts"), { recursive: true });
    await mkdir(join(tmp, "wiki", "entities"), { recursive: true });
    await writeFile(join(tmp, "wiki", "concepts", "vault-knowledge.md"), [
      "---",
      "type: Concept",
      "title: Vault Knowledge",
      "description: Shared knowledge substrate.",
      "---",
      "",
      "# Vault Knowledge",
      "",
      "Piren links to [[Pi Coding Agent]] and https://example.com/okf.",
    ].join("\n"));
    await writeFile(join(tmp, "wiki", "entities", "pi-coding-agent.md"), [
      "---",
      "type: Entity",
      "title: Pi Coding Agent",
      "---",
      "",
      "# Pi Coding Agent",
    ].join("\n"));
    vaultRoot = tmp;
  });

  afterEach(async () => {
    await rm(join(process.cwd(), "tests", "fixtures", ".vault-graph-route-test"), {
      recursive: true,
      force: true,
    });
  });

  it("returns a read-only OKF graph with vault-relative node paths and directed edges", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/graph`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        nodes: Array<{ id: string; path: string; type: string; title: string; description?: string }>;
        edges: Array<{ source: string; target: string; kind: string; external: boolean }>;
        problems: unknown[];
        truncated: boolean;
      };

      expect(body.nodes).toEqual([
        {
          id: "wiki/concepts/vault-knowledge.md",
          path: "wiki/concepts/vault-knowledge.md",
          type: "Concept",
          title: "Vault Knowledge",
          description: "Shared knowledge substrate.",
        },
        {
          id: "wiki/entities/pi-coding-agent.md",
          path: "wiki/entities/pi-coding-agent.md",
          type: "Entity",
          title: "Pi Coding Agent",
        },
      ]);
      expect(body.edges).toEqual([
        {
          source: "wiki/concepts/vault-knowledge.md",
          target: "wiki/entities/pi-coding-agent.md",
          href: "Pi Coding Agent",
          kind: "wikilink",
          external: false,
        },
        {
          source: "wiki/concepts/vault-knowledge.md",
          target: "https://example.com/okf",
          href: "https://example.com/okf",
          kind: "external",
          external: true,
        },
      ]);
      expect(body.problems).toEqual([]);
      expect(body.truncated).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns 404 when vaultRoot is not configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/graph`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
