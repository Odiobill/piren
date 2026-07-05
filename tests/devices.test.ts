import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDevice } from "../src/devices.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-devices-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "team", "thor"), { recursive: true });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Phase 2 device registration", () => {
  it("writes one device heartbeat JSON file under the selected agent", async () => {
    const result = await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      priority: 10,
      now: () => new Date("2026-06-23T09:30:00.000Z"),
    });

    expect(result.path).toBe("team/thor/devices/heimdall.json");
    expect(result.agentName).toBe("thor");
    expect(result.deviceId).toBe("heimdall");
    expect(result.hostname).toBe("heimdall.local");
    expect(result.status).toBe("active");
    expect(result.lastSeen).toBe("2026-06-23T09:30:00.000Z");

    const content = await readFile(join(vault, result.path), "utf8");
    expect(JSON.parse(content)).toEqual({
      device_id: "heimdall",
      hostname: "heimdall.local",
      priority: 10,
      status: "active",
      started_at: "2026-06-23T09:30:00.000Z",
      last_seen: "2026-06-23T09:30:00.000Z",
    });
  });

  it("preserves existing priority when refreshing without explicit priority", async () => {
    // First registration with priority 1
    await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      priority: 1,
      now: () => new Date("2026-06-23T09:00:00.000Z"),
    });

    // Refresh without explicit priority: should preserve 1, not default to 10
    const result = await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      now: () => new Date("2026-06-23T09:30:00.000Z"),
    });

    expect(result.priority).toBe(1);
    const content = await readFile(join(vault, result.path), "utf8");
    expect(JSON.parse(content).priority).toBe(1);
  });

  it("explicit priority overrides existing priority on refresh", async () => {
    await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      priority: 1,
      now: () => new Date("2026-06-23T09:00:00.000Z"),
    });

    const result = await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      priority: 5,
      now: () => new Date("2026-06-23T09:30:00.000Z"),
    });

    expect(result.priority).toBe(5);
    const content = await readFile(join(vault, result.path), "utf8");
    expect(JSON.parse(content).priority).toBe(5);
  });

  it("defaults to priority 10 when no existing file exists", async () => {
    const result = await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      now: () => new Date("2026-06-23T09:30:00.000Z"),
    });

    expect(result.priority).toBe(10);
    const content = await readFile(join(vault, result.path), "utf8");
    expect(JSON.parse(content).priority).toBe(10);
  });

  it("defaults to priority 10 when existing file has no valid priority", async () => {
    // Manually write a file with no priority field
    await mkdir(join(vault, "team", "thor", "devices"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "devices", "heimdall.json"),
      JSON.stringify({ device_id: "heimdall", hostname: "heimdall.local", status: "active", last_seen: "2026-06-23T09:00:00.000Z" }),
      "utf8",
    );

    const result = await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      now: () => new Date("2026-06-23T09:30:00.000Z"),
    });

    expect(result.priority).toBe(10);
    const content = await readFile(join(vault, result.path), "utf8");
    expect(JSON.parse(content).priority).toBe(10);
  });

  it("preserves priority even when steward manually edited the file between refreshes", async () => {
    // First registration with default priority
    await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      now: () => new Date("2026-06-23T09:00:00.000Z"),
    });

    // Steward manually edits the file to change priority from 10 to 2
    const filePath = join(vault, "team", "thor", "devices", "heimdall.json");
    const existing = JSON.parse(await readFile(filePath, "utf8"));
    existing.priority = 2;
    await writeFile(filePath, JSON.stringify(existing), "utf8");

    // Refresh: should preserve the manually-edited priority 2
    const result = await registerDevice({
      vaultRoot: vault,
      agentName: "thor",
      deviceId: "heimdall",
      hostname: "heimdall.local",
      now: () => new Date("2026-06-23T09:30:00.000Z"),
    });

    expect(result.priority).toBe(2);
  });
});
