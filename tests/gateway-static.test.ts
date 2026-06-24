import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
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

async function makePublicDir() {
  const dir = await mkdtemp(join(tmpdir(), "piren-public-"));
  await writeFile(join(dir, "index.html"), "<!DOCTYPE html><html><body>chat</body></html>");
  await writeFile(join(dir, "style.css"), "body { margin: 0; }");
  await writeFile(join(dir, "app.js"), "console.log('hi');");
  return dir;
}

describe("Gateway static file serving", () => {
  it("serves index.html at GET /", async () => {
    const publicDir = await makePublicDir();
    const server = new GatewayServer({ target: fakePiTarget(), publicDir });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("chat");
    } finally {
      await server.close();
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it("serves style.css with correct content-type", async () => {
    const publicDir = await makePublicDir();
    const server = new GatewayServer({ target: fakePiTarget(), publicDir });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/style.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/css");
      const body = await res.text();
      expect(body).toContain("margin");
    } finally {
      await server.close();
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it("serves app.js with correct content-type", async () => {
    const publicDir = await makePublicDir();
    const server = new GatewayServer({ target: fakePiTarget(), publicDir });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      const body = await res.text();
      expect(body).toContain("console.log");
    } finally {
      await server.close();
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing static files", async () => {
    const publicDir = await makePublicDir();
    const server = new GatewayServer({ target: fakePiTarget(), publicDir });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/nonexistent.js`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal attempts (defense-in-depth)", async () => {
    const publicDir = await makePublicDir();
    const server = new GatewayServer({ target: fakePiTarget(), publicDir });
    try {
      const handle = await server.start();
      // The URL constructor normalizes ../ sequences, so this resolves to
      // /etc/passwd inside publicDir and returns 404 (file not found), not
      // the actual /etc/passwd. The relative() check in handleStatic is
      // defense-in-depth for any path that might escape normalization.
      const res = await fetch(`http://${handle.hostname}:${handle.port}/../../../etc/passwd`);
      expect([403, 404]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain("root:");
    } finally {
      await server.close();
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it("API routes still work when publicDir is configured", async () => {
    const publicDir = await makePublicDir();
    const server = new GatewayServer({ target: fakePiTarget(), publicDir });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/api/auth/info`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authRequired: boolean };
      expect(body.authRequired).toBe(false);
    } finally {
      await server.close();
      await rm(publicDir, { recursive: true, force: true });
    }
  });

  it("does not serve static files when publicDir is not configured", async () => {
    const server = new GatewayServer({ target: fakePiTarget() });
    try {
      const handle = await server.start();
      const res = await fetch(`http://${handle.hostname}:${handle.port}/`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
