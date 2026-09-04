import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayServer } from "../src/gateway-http.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: {} };
}

const alert = [
  "---",
  "type: Alert",
  "id: 20260904T180100000Z-vault-unavailable",
  "from: thor",
  "severity: urgent",
  "status: open",
  "created: 2026-09-04T18:01:00.000Z",
  "notify: true",
  "---",
  "",
  "# Vault unavailable",
  "",
  "The vault cannot be reached.",
  "",
].join("\n");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-steward-alerts-gateway-"));
  await mkdir(join(root, "steward-inbox", "alerts"), { recursive: true });
  await writeFile(join(root, "steward-inbox", "alerts", "vault-unavailable.md"), alert, "utf8");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("steward alert gateway adapter", () => {
  it("authenticates bounded active-alert list/detail and exact one-way close routes", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: root, authToken: "test-token" });
    try {
      const handle = await server.start();
      const base = `http://${handle.hostname}:${handle.port}`;
      const headers = { authorization: "Bearer test-token" };

      expect((await fetch(`${base}/api/steward-alerts`)).status).toBe(401);

      const listed = await fetch(`${base}/api/steward-alerts`, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        attention_count: 1,
        alerts: [expect.objectContaining({
          path: "steward-inbox/alerts/vault-unavailable.md",
          id: "20260904T180100000Z-vault-unavailable",
          severity: "urgent",
          status: "open",
        })],
      });

      const path = "steward-inbox/alerts/vault-unavailable.md";
      const detail = await fetch(`${base}/api/steward-alerts/read?path=${encodeURIComponent(path)}`, { headers });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual(expect.objectContaining({ path, content: alert }));

      const closed = await fetch(`${base}/api/steward-alerts/close`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ path, expected_status: "open" }),
      });
      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual(expect.objectContaining({ path, status: "closed", closed_via: "workbench" }));
      expect(await readFile(join(root, path), "utf8")).toContain("status: closed");

      const stale = await fetch(`${base}/api/steward-alerts/close`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ path, expected_status: "open" }),
      });
      expect(stale.status).toBe(409);
    } finally {
      await server.close();
    }
  });
});
