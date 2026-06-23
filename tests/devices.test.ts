import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
});
