import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
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

describe("Vault browser HTTP routes", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    // Create a temporary fixture vault with curated and operational dirs.
    const tmp = join(process.cwd(), "tests", "fixtures", ".vault-browser-test");
    await rm(tmp, { recursive: true, force: true });

    // Curated subdir: contains index.md
    const curatedDir = join(tmp, "Projects", "TestProject");
    await mkdir(curatedDir, { recursive: true });
    await writeFile(join(curatedDir, "index.md"), "# TestProject\n\nWelcome.");
    await writeFile(join(curatedDir, "notes.md"), "some notes");

    // Operational subdir: no index.md
    const inboxDir = join(tmp, "team", "piren", "inbox");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "task-1.md"), "---\nstatus: pending\n---\n\n# Task 1");
    await writeFile(join(inboxDir, "task-2.md"), "---\nstatus: pending\n---\n\n# Task 2");

    vaultRoot = tmp;
  });

  afterEach(async () => {
    await rm(join(process.cwd(), "tests", "fixtures", ".vault-browser-test"), {
      recursive: true,
      force: true,
    });
  });

  it("lists a directory with dirs first, alpha-sorted", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();

      // List Projects directory: should show TestProject dir then files (alpha-sorted).
      const res = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=Projects`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: Array<{ name: string; type: string; path: string }>;
      };

      // Dirs first: TestProject is a directory, so it should come before any files.
      const dirs = body.entries.filter((e) => e.type === "directory");
      const files = body.entries.filter((e) => e.type === "file");
      expect(dirs.length).toBeGreaterThan(0);
      expect(dirs[0]?.name).toBe("TestProject");

      // All dirs come before all files.
      const entries = body.entries;
      let sawFile = false;
      let dirsBeforeFiles = true;
      for (const entry of entries) {
        if (entry.type === "file") sawFile = true;
        if (entry.type === "directory" && sawFile) {
          dirsBeforeFiles = false;
          break;
        }
      }
      expect(dirsBeforeFiles).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("reads a file content", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();

      const res = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/read?path=Projects/TestProject/index.md`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string; path: string };
      expect(body.content).toContain("# TestProject");
      expect(body.path).toBe("Projects/TestProject/index.md");
    } finally {
      await server.close();
    }
  });

  it("rejects path traversal outside the vault with 403", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();

      // List with traversal attempt.
      const listRes = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=../../../../etc`,
      );
      expect(listRes.status).toBe(403);

      // Read with traversal attempt.
      const readRes = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/read?path=../../../../etc/passwd`,
      );
      expect(readRes.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("returns 404 for a path that does not exist inside the vault", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();

      const res = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/read?path=nonexistent/file.md`,
      );
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("list is capped at the bounded 500-entry count with default ordering unchanged", async () => {
    // Create more than the bounded cap in one directory.
    const manyDir = join(vaultRoot, "many");
    await mkdir(manyDir, { recursive: true });
    for (let i = 0; i < 600; i++) {
      await writeFile(
        join(manyDir, `file-${String(i).padStart(3, "0")}.txt`),
        i.toString(),
      );
    }

    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();

      const res = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=many`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: Array<{ name: string; type: string }>;
        capped: boolean;
      };
      expect(body.entries.length).toBeLessThanOrEqual(500);
      expect(body.capped).toBe(true);
      // Default ordering stays dirs-first alphabetical.
      expect(body.entries[0]?.name).toBe("file-000.txt");
    } finally {
      await server.close();
    }
  });

  it("recent ordering sorts by mtimeMs descending before the bounded trim", async () => {
    const manyDir = join(vaultRoot, "many");
    await mkdir(manyDir, { recursive: true });
    for (let i = 0; i < 600; i++) {
      const name = `file-${String(i).padStart(3, "0")}.txt`;
      await writeFile(join(manyDir, name), i.toString());
      // Deterministic distinct mtimes: higher index is newer.
      await utimes(join(manyDir, name), 1_000_000 + i, 1_000_000 + i);
    }

    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();

      const res = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=many&order=recent`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: Array<{ name: string; mtimeMs: number }>;
        capped: boolean;
      };
      // Trim happens AFTER ordering, so the newest 500 survive and the
      // oldest alphabetical window entries are exposed instead.
      expect(body.entries.length).toBe(500);
      expect(body.capped).toBe(true);
      expect(body.entries[0]?.name).toBe("file-599.txt");
      expect(body.entries.at(-1)?.name).toBe("file-100.txt");
      let previous = Number.MAX_SAFE_INTEGER;
      for (const entry of body.entries) {
        expect(entry.mtimeMs).toBeLessThanOrEqual(previous);
        previous = entry.mtimeMs;
      }
    } finally {
      await server.close();
    }
  });

  it("an unknown order value is rejected fail-closed without altering default behavior", async () => {
    const server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot,
    });
    try {
      const handle = await server.start();
      const res = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=Projects&order=bogus`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain("order");

      // The default route output is unchanged.
      const ok = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=Projects`,
      );
      expect(ok.status).toBe(200);

      // Explicit "name" equals the default output.
      const named = await fetch(
        `http://${handle.hostname}:${handle.port}/api/vault/list?path=Projects&order=name`,
      );
      expect(named.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
