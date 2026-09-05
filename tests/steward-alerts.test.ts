import { describe, expect, it } from "vitest";
import {
  closeStewardAlert,
  parseStewardAlert,
  projectStewardAlerts,
} from "../src/steward-alerts.js";
import { planStewardAlertArchive } from "../src/steward-alert-archive.js";

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

  it("parses the historical resolved grammar truthfully without relabeling or counting it", () => {
    const historical = openHigh
      .replace("status: open", "status: resolved\nresolved: 2026-08-04T11:19:00Z")
      .replace("severity: high", "severity: urgent");
    const parsed = parseStewardAlert({
      path: "steward-inbox/alerts/20260804T110454270Z-credential-exposed.md",
      content: historical,
    });

    expect(parsed.status).toBe("resolved");
    expect(parsed.resolvedAt).toBe("2026-08-04T11:19:00Z");
    expect(parsed.closedAt).toBeUndefined();
    expect(parsed.closedVia).toBeUndefined();

    // The slightly broader legacy timestamp grammar still requires an explicit
    // UTC instant; canonical millisecond precision is accepted too.
    expect(parseStewardAlert({
      path: "steward-inbox/alerts/20260804T110454270Z-credential-exposed.md",
      content: historical.replace("resolved: 2026-08-04T11:19:00Z", "resolved: 2026-08-04T11:19:00.000Z"),
    }).resolvedAt).toBe("2026-08-04T11:19:00.000Z");

    const open = parseStewardAlert({
      path: "steward-inbox/alerts/normal.md",
      content: openHigh.replace("severity: high", "severity: normal"),
    });
    const projection = projectStewardAlerts([parsed, open]);
    expect(projection.attentionCount).toBe(0);
    expect(projection.alerts.map((alert) => alert.status)).toEqual(["open", "resolved"]);
  });

  it("fails closed on missing, malformed, or misplaced resolved evidence", () => {
    const legacyResolved = (line: string) => openHigh.replace("status: open", `status: resolved\n${line}`);

    // Resolved without its required timestamp evidence is malformed.
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/resolved-no-evidence.md",
      content: openHigh.replace("status: open", "status: resolved"),
    })).toThrow("missing required resolved");

    // Malformed resolved timestamps are rejected.
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/resolved-bad-evidence.md",
      content: legacyResolved("resolved: 2026-08-04 11:19:00"),
    })).toThrow("canonical");
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/resolved-local-evidence.md",
      content: legacyResolved("resolved: 2026-08-04T11:19:00+02:00"),
    })).toThrow("canonical");

    // Closure evidence on a resolved record is rejected.
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/resolved-with-closure.md",
      content: legacyResolved("resolved: 2026-08-04T11:19:00Z\nclosed_at: 2026-09-04T17:00:00.000Z\nclosed_via: workbench"),
    })).toThrow("closure evidence");

    // Resolved evidence outside the legacy resolved status is rejected.
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/open-with-resolved.md",
      content: openHigh.replace("notify: true", "notify: true\nresolved: 2026-08-04T11:19:00Z"),
    })).toThrow("resolved evidence");
    expect(() => parseStewardAlert({
      path: "steward-inbox/alerts/closed-with-resolved.md",
      content: openHigh
        .replace("status: open", "status: closed\nclosed_at: 2026-09-04T17:00:00.000Z\nclosed_via: workbench")
        .replace("notify: true", "notify: true\nresolved: 2026-08-04T11:19:00Z"),
    })).toThrow("resolved evidence");
  });

  it("keeps a legacy resolved alert outside the new close lifecycle and archive eligibility", () => {
    const resolved = openHigh.replace("status: open", "status: resolved\nresolved: 2026-08-04T11:19:00Z");
    const path = "steward-inbox/alerts/20260804T110454270Z-credential-exposed.md";

    expect(() => closeStewardAlert({ path, content: resolved, closedAt: "2026-09-04T17:00:00.000Z" }))
      .toThrow("not closeable");

    const alert = parseStewardAlert({ path, content: resolved });
    expect(() => planStewardAlertArchive({ alert, archiveAt: "2026-09-05T14:00:00.000Z" }))
      .toThrow("Only closed alerts may be archived.");
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
