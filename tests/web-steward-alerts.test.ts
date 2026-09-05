import { describe, expect, it } from "vitest";
import { parseStewardAlertDetail, parseStewardAlertsResponse } from "../web/src/steward-alerts.js";

describe("steward alert browser response decoders", () => {
  it("strictly parses the bounded list and exact detail response", () => {
    const list = parseStewardAlertsResponse({
      attention_count: 2,
      alerts: [
        {
          path: "steward-inbox/alerts/urgent.md",
          id: "urgent-alert",
          severity: "urgent",
          status: "open",
          title: "Vault unavailable",
          created: "2026-09-04T18:01:00.000Z",
        },
      ],
    });
    expect(list.attentionCount).toBe(2);
    expect(list.alerts[0]).toMatchObject({ path: "steward-inbox/alerts/urgent.md", severity: "urgent" });

    expect(parseStewardAlertDetail({
      ...list.alerts[0],
      content: "---\ntype: Alert\n---\n# Vault unavailable\n",
    })).toMatchObject({ status: "open", content: expect.stringContaining("# Vault unavailable") });
  });

  it("strictly parses the historical resolved summary and detail without closed evidence", () => {
    const resolved = {
      path: "steward-inbox/alerts/historical-resolved.md",
      id: "20260804T110454270Z-credential-exposed-in-team-kimi-config-yml",
      severity: "urgent",
      status: "resolved",
      title: "Credential exposed in team/kimi/config.yml",
      created: "2026-08-04T11:04:54.270Z",
      resolved_at: "2026-08-04T11:19:00Z",
    };
    const parsed = parseStewardAlertsResponse({ attention_count: 0, alerts: [resolved] });
    expect(parsed.alerts[0]).toMatchObject({ status: "resolved", resolvedAt: "2026-08-04T11:19:00Z" });
    expect(parsed.alerts[0]).not.toHaveProperty("closedAt");
    expect(parseStewardAlertDetail({ ...resolved, content: "# Credential exposed" }))
      .toMatchObject({ status: "resolved", resolvedAt: "2026-08-04T11:19:00Z", content: "# Credential exposed" });

    // Second-precision legacy UTC instant is accepted; canonical millisecond is too.
    expect(parseStewardAlertsResponse({
      attention_count: 0,
      alerts: [{ ...resolved, resolved_at: "2026-08-04T11:19:00.000Z" }],
    }).alerts[0]).toMatchObject({ resolvedAt: "2026-08-04T11:19:00.000Z" });
  });

  it("accepts absent legacy resolved time but rejects malformed or misplaced evidence", () => {
    const base = {
      path: "steward-inbox/alerts/historical-resolved.md",
      id: "historical",
      severity: "urgent",
      status: "resolved",
      title: "Credential exposed",
      created: "2026-08-04T11:04:54.270Z",
    };
    // The oldest legitimate pre-P1b resolved projection has no timestamp.
    // It remains resolved with unknown time rather than being relabeled or
    // assigned an inferred timestamp.
    expect(parseStewardAlertsResponse({ attention_count: 0, alerts: [base] }).alerts[0])
      .toMatchObject({ status: "resolved" });
    expect(parseStewardAlertsResponse({ attention_count: 0, alerts: [base] }).alerts[0])
      .not.toHaveProperty("resolvedAt");
    // A present-but-malformed resolved_at is rejected.
    expect(() => parseStewardAlertsResponse({
      attention_count: 0,
      alerts: [{ ...base, resolved_at: "2026-08-04 11:19:00" }],
    })).toThrow();
    // Closed evidence on a resolved record is rejected.
    expect(() => parseStewardAlertsResponse({
      attention_count: 0,
      alerts: [{ ...base, resolved_at: "2026-08-04T11:19:00Z", closed_at: "2026-09-04T17:00:00.000Z", closed_via: "workbench" }],
    })).toThrow();
    // Resolved evidence on an open record is rejected.
    expect(() => parseStewardAlertsResponse({
      attention_count: 1,
      alerts: [{ ...base, status: "open", resolved_at: "2026-08-04T11:19:00Z" }],
    })).toThrow();
  });

  it("fails closed on malformed status, count, closure evidence, and unexpected keys", () => {
    const base = {
      path: "steward-inbox/alerts/a.md",
      id: "a",
      severity: "high",
      status: "open",
      title: "A",
      created: "2026-09-04T18:01:00.000Z",
    };
    expect(() => parseStewardAlertsResponse({ attention_count: "1", alerts: [base] })).toThrow();
    expect(() => parseStewardAlertsResponse({ attention_count: 1, alerts: [{ ...base, status: "unknown" }] })).toThrow();
    expect(() => parseStewardAlertsResponse({ attention_count: 1, alerts: [{ ...base, closed_at: "2026-09-04T18:02:00.000Z" }] })).toThrow();
    expect(() => parseStewardAlertDetail({ ...base, content: "x", extra: true })).toThrow();
  });
});
