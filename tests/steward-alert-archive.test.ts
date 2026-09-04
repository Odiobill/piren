import { describe, expect, it } from "vitest";
import { planStewardAlertArchive } from "../src/steward-alert-archive.js";

const closedAlert = {
  path: "steward-inbox/alerts/20260904T164500000Z-vault-unavailable.md",
  id: "20260904T164500000Z-vault-unavailable",
  from: "thor",
  severity: "high" as const,
  status: "closed" as const,
  created: "2026-09-04T16:45:00.000Z",
  closedAt: "2026-09-04T17:00:00.000Z",
  closedVia: "workbench" as const,
  title: "Vault unavailable",
};

describe("steward-alert archive planning", () => {
  it("plans one exact closed direct alert into a date-partitioned archive without mutating evidence", () => {
    expect(planStewardAlertArchive(closedAlert)).toEqual({
      sourcePath: closedAlert.path,
      destinationPath: "steward-inbox/alerts/archive/2026/09/04/20260904T164500000Z-vault-unavailable.md",
    });
  });

  it("fails closed for open, malformed, or non-direct alert candidates", () => {
    expect(() => planStewardAlertArchive({ ...closedAlert, status: "open" })).toThrow("closed");
    expect(() => planStewardAlertArchive({ ...closedAlert, path: "steward-inbox/alerts/archive/old.md" })).toThrow("direct");
    const { closedAt: _closedAt, ...missingClosure } = closedAlert;
    expect(() => planStewardAlertArchive(missingClosure)).toThrow("closure");
  });
});
