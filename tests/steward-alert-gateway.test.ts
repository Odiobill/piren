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

// The real historical pre-P1b record observed in the authoritative vault:
// `status: resolved` plus one explicit UTC second-precision `resolved` instant.
const historicalResolved = [
  "---",
  "type: Alert",
  "id: 20260804T110454270Z-credential-exposed-in-team-kimi-config-yml",
  "from: sam",
  "severity: urgent",
  "status: resolved",
  "created: 2026-08-04T11:04:54.270Z",
  "resolved: 2026-08-04T11:19:00Z",
  "notify: true",
  "---",
  "",
  "# Credential exposed in team/kimi/config.yml",
  "",
].join("\n");

// The oldest legitimate pre-P1b resolved record predates resolution-time
// evidence. Read compatibility preserves that unknown rather than inferring it.
const earliestHistoricalResolved = [
  "---",
  "type: Alert",
  "id: 20260720T205927228Z-v0-1-4-published-with-a-p4-migration-verification-failure",
  "from: sam",
  "severity: high",
  "status: resolved",
  "created: 2026-07-20T20:59:27.228Z",
  "notify: true",
  "---",
  "",
  "# v0.1.4 published with a P4 migration verification failure",
  "",
].join("\n");

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

  it("lists and reads historical resolved alerts with and without explicit resolution time", async () => {
    await writeFile(join(root, "steward-inbox", "alerts", "historical-resolved.md"), historicalResolved, "utf8");
    await writeFile(join(root, "steward-inbox", "alerts", "earliest-historical-resolved.md"), earliestHistoricalResolved, "utf8");
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot: root, authToken: "test-token" });
    try {
      const handle = await server.start();
      const base = `http://${handle.hostname}:${handle.port}`;
      const headers = { authorization: "Bearer test-token" };
      const resolvedPath = "steward-inbox/alerts/historical-resolved.md";

      // The bounded whole-list read now succeeds and preserves the legacy
      // status truthfully; the open urgent alert alone drives the count.
      const listed = await fetch(`${base}/api/steward-alerts`, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        attention_count: 1,
        alerts: [
          expect.objectContaining({ path: "steward-inbox/alerts/vault-unavailable.md", status: "open" }),
          expect.objectContaining({ path: resolvedPath, status: "resolved", resolved_at: "2026-08-04T11:19:00Z" }),
          {
            path: "steward-inbox/alerts/earliest-historical-resolved.md",
            id: "20260720T205927228Z-v0-1-4-published-with-a-p4-migration-verification-failure",
            severity: "high",
            status: "resolved",
            title: "v0.1.4 published with a P4 migration verification failure",
            created: "2026-07-20T20:59:27.228Z",
          },
        ],
      });

      const detail = await fetch(`${base}/api/steward-alerts/read?path=${encodeURIComponent(resolvedPath)}`, { headers });
      expect(detail.status).toBe(200);
      const detailBody = await detail.json();
      expect(detailBody).toEqual(expect.objectContaining({ status: "resolved", resolved_at: "2026-08-04T11:19:00Z" }));
      expect(detailBody).not.toHaveProperty("closed_at");
      expect(detailBody).not.toHaveProperty("closed_via");

      // A legacy resolved record is not closeable; the 409 names its real status.
      const close = await fetch(`${base}/api/steward-alerts/close`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ path: resolvedPath, expected_status: "open" }),
      });
      expect(close.status).toBe(409);
      expect(await close.json()).toEqual({ error: "alert is resolved, not open" });
    } finally {
      await server.close();
    }
  });
});
