import { describe, expect, it } from "vitest";
import {
  closeStewardAlert,
  parseStewardAlert,
  projectStewardAlerts,
} from "../src/steward-alerts.js";

const openHigh = [
  "---",
  "type: Alert",
  "id: 20260904T164500000Z-vault-unavailable",
  "from: thor",
  "severity: high",
  "status: open",
  "created: 2026-09-04T16:45:00.000Z",
  "notify: true",
  "---",
  "",
  "# Vault unavailable",
  "",
  "The source mount is unavailable.",
  "",
].join("\n");

describe("steward alert lifecycle core", () => {
  it("parses only direct active alert files and projects deterministic attention facts", () => {
    const high = parseStewardAlert({
      path: "steward-inbox/alerts/20260904T164500000Z-vault-unavailable.md",
      content: openHigh,
    });
    const normal = parseStewardAlert({
      path: "steward-inbox/alerts/normal.md",
      content: openHigh.replace("severity: high", "severity: normal").replace("id: 20260904T164500000Z-vault-unavailable", "id: normal-alert"),
    });
    const urgent = parseStewardAlert({
      path: "steward-inbox/alerts/urgent.md",
      content: openHigh.replace("severity: high", "severity: urgent").replace("id: 20260904T164500000Z-vault-unavailable", "id: urgent-alert").replace("2026-09-04T16:45:00.000Z", "2026-09-04T16:46:00.000Z"),
    });

    expect(projectStewardAlerts([normal, high, urgent])).toEqual({
      attentionCount: 2,
      alerts: [
        expect.objectContaining({ id: "urgent-alert", severity: "urgent", title: "Vault unavailable", status: "open" }),
        expect.objectContaining({ id: "20260904T164500000Z-vault-unavailable", severity: "high", title: "Vault unavailable", status: "open" }),
        expect.objectContaining({ id: "normal-alert", severity: "normal", title: "Vault unavailable", status: "open" }),
      ],
    });

    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/archive/2026/09/04/old.md",
      content: openHigh,
    })).toThrow("direct active alert");
  });

  it("closes one open alert by preserving its original evidence and adding bounded closure evidence", () => {
    const closed = closeStewardAlert({
      path: "steward-inbox/alerts/20260904T164500000Z-vault-unavailable.md",
      content: openHigh,
      closedAt: "2026-09-04T17:00:00.000Z",
    });

    expect(closed.alert).toMatchObject({
      status: "closed",
      closedAt: "2026-09-04T17:00:00.000Z",
      closedVia: "workbench",
    });
    expect(closed.content).toContain("status: closed");
    expect(closed.content).toContain("closed_at: 2026-09-04T17:00:00.000Z");
    expect(closed.content).toContain("closed_via: workbench");
    expect(closed.content).toContain("id: 20260904T164500000Z-vault-unavailable");
    expect(closed.content).toContain("The source mount is unavailable.");
  });

  it("fails closed for malformed, stale, and already-closed evidence", () => {
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/bad.md",
      content: openHigh.replace("type: Alert", "type: Task"),
    })).toThrow("type");

    const alreadyClosed = openHigh.replace("status: open", "status: closed\nclosed_at: 2026-09-04T17:00:00.000Z\nclosed_via: workbench");
    expect(() => closeStewardAlert({
      path: "steward-inbox/alerts/already-closed.md",
      content: alreadyClosed,
      closedAt: "2026-09-04T17:01:00.000Z",
    })).toThrow("already closed");
  });
});
