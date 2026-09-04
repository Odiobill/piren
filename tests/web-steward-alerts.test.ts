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
