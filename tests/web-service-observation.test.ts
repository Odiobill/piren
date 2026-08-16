import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseServiceStatusSnapshot,
  SERVICE_MANAGER_LABELS,
  SERVICE_STATE_LABELS,
  SERVICE_TARGET_LABELS,
  serviceStateStatusClass,
  type ServiceStatusSnapshot,
} from "../web/src/service-observation.js";

/**
 * D2.3 — typed browser parser for GET /api/services/status (accepted
 * contract: Projects/Piren/workbench-dashboard-service-observability-contract.md).
 * Gateway JSON is untrusted: the parser accepts only the exact bounded
 * five-state, three-target fixed-order snapshot and rejects malformed,
 * extra-field, invalid-enum/order, non-canonical-timestamp, or
 * gateway-target responses fail-closed, so the Dashboard never displays an
 * invented state.
 */

const VALID: ServiceStatusSnapshot = {
  observedAt: "2026-08-16T12:00:00.000Z",
  manager: "systemd-user",
  targets: [
    { target: "telegram", state: "active" },
    { target: "discord", state: "unknown" },
    { target: "scheduler", state: "not-installed" },
  ],
};

describe("parseServiceStatusSnapshot (D2.3)", () => {
  it("accepts the exact bounded snapshot for every manager kind and state", () => {
    expect(parseServiceStatusSnapshot(VALID)).toEqual(VALID);
    for (const manager of ["systemd-user", "tmux-cron", "unavailable"] as const) {
      const snapshot = { ...VALID, manager };
      expect(parseServiceStatusSnapshot(snapshot)).toEqual(snapshot);
    }
    for (const state of ["active", "inactive", "not-installed", "unavailable", "unknown"] as const) {
      const snapshot = {
        observedAt: "2026-08-16T12:00:00.000Z",
        manager: "tmux-cron",
        targets: [
          { target: "telegram", state },
          { target: "discord", state },
          { target: "scheduler", state },
        ],
      };
      expect(parseServiceStatusSnapshot(snapshot)).toEqual(snapshot);
    }
  });

  it("rejects non-object and malformed bodies fail-closed", () => {
    for (const bad of [null, undefined, "nope", 42, [], [{ target: "telegram" }]]) {
      expect(() => parseServiceStatusSnapshot(bad)).toThrow();
    }
    expect(() => parseServiceStatusSnapshot({})).toThrow();
    expect(() => parseServiceStatusSnapshot({ observedAt: 1, manager: "systemd-user", targets: [] })).toThrow();
  });

  it("rejects extra or missing envelope fields (no invented state)", () => {
    expect(() => parseServiceStatusSnapshot({ ...VALID, diagnostics: "systemctl output" })).toThrow();
    expect(() => parseServiceStatusSnapshot({ ...VALID, gateway: { state: "active" } })).toThrow();
    const { observedAt: _dropped, ...missing } = VALID;
    expect(() => parseServiceStatusSnapshot(missing)).toThrow();
  });

  it("rejects a non-canonical or invalid observedAt timestamp", () => {
    expect(() => parseServiceStatusSnapshot({ ...VALID, observedAt: "not-a-date" })).toThrow();
    // Non-canonical (parseable but not the canonical ISO form) is rejected.
    expect(() => parseServiceStatusSnapshot({ ...VALID, observedAt: "2026-08-16 12:00:00" })).toThrow();
    expect(() => parseServiceStatusSnapshot({ ...VALID, observedAt: "2026-08-16T12:00:00+02:00" })).toThrow();
  });

  it("rejects an invalid manager enum", () => {
    expect(() => parseServiceStatusSnapshot({ ...VALID, manager: "kubernetes" })).toThrow();
    expect(() => parseServiceStatusSnapshot({ ...VALID, manager: "systemd" })).toThrow();
  });

  it("rejects an invalid state enum", () => {
    const snapshot = {
      ...VALID,
      targets: [
        { target: "telegram", state: "healthy" },
        { target: "discord", state: "active" },
        { target: "scheduler", state: "active" },
      ],
    };
    expect(() => parseServiceStatusSnapshot(snapshot)).toThrow();
  });

  it("rejects a wrong target order and any gateway target", () => {
    const reordered = {
      ...VALID,
      targets: [
        { target: "discord", state: "active" },
        { target: "telegram", state: "active" },
        { target: "scheduler", state: "active" },
      ],
    };
    expect(() => parseServiceStatusSnapshot(reordered)).toThrow();
    const gatewayFirst = {
      ...VALID,
      targets: [
        { target: "gateway", state: "active" },
        { target: "discord", state: "active" },
        { target: "scheduler", state: "active" },
      ],
    };
    expect(() => parseServiceStatusSnapshot(gatewayFirst)).toThrow();
  });

  it("rejects a wrong target count and malformed/extra-field entries", () => {
    expect(() => parseServiceStatusSnapshot({ ...VALID, targets: VALID.targets.slice(0, 2) })).toThrow();
    expect(() => parseServiceStatusSnapshot({ ...VALID, targets: [...VALID.targets, { target: "gateway", state: "active" }] })).toThrow();
    const extra = {
      ...VALID,
      targets: [
        { target: "telegram", state: "active", pid: 1234 },
        { target: "discord", state: "active" },
        { target: "scheduler", state: "active" },
      ],
    };
    expect(() => parseServiceStatusSnapshot(extra)).toThrow();
    const missingState = {
      ...VALID,
      targets: [{ target: "telegram" }, { target: "discord", state: "active" }, { target: "scheduler", state: "active" }],
    };
    expect(() => parseServiceStatusSnapshot(missingState)).toThrow();
  });
});

describe("service observation presentation labels (D2.3)", () => {
  it("labels the three fixed targets in contract vocabulary", () => {
    expect(SERVICE_TARGET_LABELS.telegram).toBe("Telegram");
    expect(SERVICE_TARGET_LABELS.discord).toBe("Discord");
    expect(SERVICE_TARGET_LABELS.scheduler).toBe("Scheduler");
  });

  it("labels every state truthfully (never healthy/online/running)", () => {
    expect(SERVICE_STATE_LABELS.active).toBe("Active");
    expect(SERVICE_STATE_LABELS.inactive).toBe("Inactive");
    expect(SERVICE_STATE_LABELS["not-installed"]).toBe("Not installed");
    expect(SERVICE_STATE_LABELS.unavailable).toBe("Manager unavailable");
    expect(SERVICE_STATE_LABELS.unknown).toBe("Unknown");
    for (const label of Object.values(SERVICE_STATE_LABELS)) {
      expect(label.toLowerCase()).not.toMatch(/healthy|online|running/);
    }
  });

  it("maps unknown and unavailable to the caution class, never a success class", () => {
    expect(serviceStateStatusClass("active")).toBe("status-ok");
    expect(serviceStateStatusClass("inactive")).toBe("status-muted");
    expect(serviceStateStatusClass("not-installed")).toBe("status-muted");
    expect(serviceStateStatusClass("unknown")).toBe("status-warn");
    expect(serviceStateStatusClass("unavailable")).toBe("status-warn");
  });

  it("names every manager source", () => {
    expect(SERVICE_MANAGER_LABELS["systemd-user"]).toContain("systemd");
    expect(SERVICE_MANAGER_LABELS["tmux-cron"]).toContain("tmux");
    expect(SERVICE_MANAGER_LABELS.unavailable.length).toBeGreaterThan(0);
  });
});

describe("D2.3 static contract pins", () => {
  it("api.ts holds the single services/status call site", async () => {
    const api = await readFile(join(process.cwd(), "web", "src", "api.ts"), "utf8");
    expect(api.match(/authedFetch\("\/api\/services\/status"/g)?.length).toBe(1);
  });

  it("the observation module and Dashboard view use no storage, polling, SSE, or WebSocket", async () => {
    for (const name of ["service-observation.ts", "DashboardView.tsx", "api.ts"]) {
      const source = await readFile(join(process.cwd(), "web", "src", name), "utf8");
      for (const forbidden of ["localStorage", "sessionStorage", "new EventSource", "new WebSocket", "setInterval"]) {
        expect(source, `${name} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
