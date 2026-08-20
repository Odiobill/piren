import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";

/**
 * W2 (0.2.0 amendment §4) — gateway integration over the EXISTING bounded
 * GET /api/vault/list and GET /api/vault/read routes only: the Vault
 * Explorer's whole transport surface is exactly those two routes. Proves the
 * routes serve a real vault with the accepted response shapes, the bounded
 * error codes (400/403/404), and that no new vault route was introduced.
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

interface VaultListJson {
  path: string;
  entries: { name: string; path: string; type: string; bytes?: number; mtimeMs: number }[];
  capped: boolean;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-w2-gateway-"));
  await mkdir(join(root, "team"), { recursive: true });
  await writeFile(join(root, "index.md"), "# Vault index\n");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("existing vault list/read routes serve the Explorer (W2)", () => {
  it("GET /api/vault/list lists the bounded root with the accepted shape", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: root });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/list?path=.`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as VaultListJson;
      // The root vault path resolves to the empty relative path.
      expect(json.path).toBe("");
      const names = json.entries.map((entry) => entry.name);
      expect(names).toContain("index.md");
      expect(names).toContain("team");
      const index = json.entries.find((entry) => entry.name === "index.md");
      expect(index?.type).toBe("file");
      expect(typeof index?.bytes).toBe("number");
      const team = json.entries.find((entry) => entry.name === "team");
      expect(team?.type).toBe("directory");
      expect(json.capped).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("GET /api/vault/read returns the document body with the accepted shape", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: root });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/read?path=index.md`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { path: string; content: string; bytes: number; mtimeMs: number; capped: boolean };
      expect(json.path).toBe("index.md");
      expect(json.content).toContain("# Vault index");
      expect(json.bytes).toBeGreaterThan(0);
      expect(json.capped).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("bounded error codes stay exactly as the Explorer expects (400/403/404)", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: root });
    try {
      const handle = await server.start();
      const base = `http://${handle.hostname}:${handle.port}`;
      expect((await fetch(`${base}/api/vault/read`)).status).toBe(400); // path required
      expect((await fetch(`${base}/api/vault/read?path=../outside`)).status).toBe(403); // outside vault
      expect((await fetch(`${base}/api/vault/list?path=missing-dir`)).status).toBe(404); // ENOENT
    } finally {
      await server.close();
    }
  });

  it("no route expansion: a made-up vault route is a 404", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: root });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/explorer`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
