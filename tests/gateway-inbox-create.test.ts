import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
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

describe("POST /api/vault/inbox (steward inbox-create affordance)", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    const tmp = join(process.cwd(), "tests", "fixtures", ".vault-inbox-create-test");
    await rm(tmp, { recursive: true, force: true });
    // A real agent directory so the target agent exists in the vault.
    const agentDir = join(tmp, "team", "piren");
    await mkdir(join(agentDir, "inbox"), { recursive: true });
    await writeFile(join(agentDir, "SOUL.md"), "# piren\n");
    vaultRoot = tmp;
  });

  afterEach(async () => {
    await rm(join(process.cwd(), "tests", "fixtures", ".vault-inbox-create-test"), {
      recursive: true,
      force: true,
    });
  });

  it("creates an inbox task file under team/<agent>/inbox/ and returns 200", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "piren", title: "Check the backups", body: "Verify the nightly backup ran." }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string; taskId: string; to: string; from: string };
      expect(body.to).toBe("piren");
      expect(body.from).toBe("steward");
      expect(body.path).toContain("team/piren/inbox/");
      expect(body.taskId).toContain("check-the-backups");

      // The file actually exists on disk with the right frontmatter.
      const fileContent = await readFile(join(vaultRoot, body.path), "utf8");
      expect(fileContent).toContain("from: steward");
      expect(fileContent).toContain("to: piren");
      expect(fileContent).toContain("status: pending");
      expect(fileContent).toContain("# Check the backups");
      expect(fileContent).toContain("Verify the nightly backup ran.");
    } finally {
      await server.close();
    }
  });

  it("rejects a request without a target agent with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "No target", body: "missing to" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects a request without a title with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "piren", body: "missing title" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("returns 403 when vaultRoot is not configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "piren", title: "x", body: "y" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("rejects an agent name that is not kebab-case with 400", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Bad Name!", title: "x", body: "y" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("returns 404 when the target agent does not exist in the vault", async () => {
    const server = new GatewayServer({ target: fakePiTarget(), vaultRoot });
    try {
      const handle = await server.start();

      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/vault/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "nonexistent-agent", title: "x", body: "y" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
