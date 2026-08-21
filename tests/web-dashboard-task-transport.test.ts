import { describe, expect, it } from "vitest";
import { buildAssignTaskBody, parseInboxTaskCreated } from "../web/src/dashboard-task.js";

/**
 * T1 — Dashboard Assign-task transport core (pure, browser-independent).
 * The browser sends exactly {to, title, body} to the EXISTING authenticated
 * POST /api/vault/inbox route; every other field (from steward, type Task,
 * normal priority, pending, requires_approval, id/timestamps/path) stays
 * server-derived. The success parser is fail-closed over the existing
 * bounded route response.
 */

describe("buildAssignTaskBody", () => {
  it("builds exactly {to, title, body} with trimmed text and nothing else", () => {
    expect(buildAssignTaskBody("dipu", "  Check the backups  ", "Verify the nightly backup ran.\n")).toEqual({
      to: "dipu",
      title: "Check the backups",
      body: "Verify the nightly backup ran.",
    });
  });
});

describe("parseInboxTaskCreated", () => {
  it("parses the existing bounded success response", () => {
    expect(
      parseInboxTaskCreated({
        taskId: "20260821T210612217Z-check-the-backups",
        path: "team/dipu/inbox/20260821T210612217Z-check-the-backups.md",
        from: "steward",
        to: "dipu",
        status: "pending",
      }),
    ).toEqual({
      taskId: "20260821T210612217Z-check-the-backups",
      path: "team/dipu/inbox/20260821T210612217Z-check-the-backups.md",
      from: "steward",
      to: "dipu",
      status: "pending",
    });
  });

  it("fails closed on malformed or incomplete responses", () => {
    expect(() => parseInboxTaskCreated(null)).toThrow();
    expect(() => parseInboxTaskCreated({})).toThrow();
    expect(() =>
      parseInboxTaskCreated({ taskId: "", path: "team/dipu/inbox/x.md", from: "steward", to: "dipu", status: "pending" }),
    ).toThrow();
    expect(() =>
      parseInboxTaskCreated({ taskId: "t", path: 7, from: "steward", to: "dipu", status: "pending" }),
    ).toThrow();
    expect(() =>
      parseInboxTaskCreated({ taskId: "t", path: "p", from: "", to: "dipu", status: "pending" }),
    ).toThrow();
    expect(() =>
      parseInboxTaskCreated({ taskId: "t", path: "p", from: "steward", to: "dipu", status: "claimed" }),
    ).toThrow();
  });
});
