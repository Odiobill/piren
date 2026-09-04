// Pure view-model tests for the B6 per-agent context-card workflow status
// (contract workbench-handoff-budget-and-agent-status-contract §4.1/§6/§7-B6).
// The view model maps ONLY gateway-provided facts (the exact-pair status
// snapshot) plus the existing validated scoped live activity runs into
// {state, shortText, accessibleText}. Fixed precedence: red > yellow >
// busy > none within an associated workflow; busy alone when only run_active
// holds; none otherwise. Color and motion are never the sole carrier.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConversationWorkflowStatus, UnauthorizedError, WorkflowBudgetHttpError } from "../web/src/api.js";
import {
  applyWorkflowStatusActivity,
  workflowStatusAccessibleName,
  workflowStatusIndicator,
  type WorkflowStatusIndicator,
  type WorkflowStatusSnapshotView,
} from "../web/src/conversation-budget-status.js";

const BASE: WorkflowStatusSnapshotView = {
  runActive: false,
  workflow: { effectiveEdges: 10, consumedEdges: 4, low: false, exhausted: false },
};

describe("B6 workflow status view model — exact truth table (§6)", () => {
  it("no association and no run renders none (no fabricated status)", () => {
    const indicator = workflowStatusIndicator("dipu", { runActive: false, workflow: null }, false);
    expect(indicator.state).toBe("none");
    expect(indicator.shortText).toBe("");
    expect(indicator.accessibleText).toBe("");
  });

  it("run_active with no associated workflow renders busy alone (non-C5 agent-first run)", () => {
    const indicator = workflowStatusIndicator("dipu", { runActive: true, workflow: null }, false);
    expect(indicator.state).toBe("busy");
    expect(indicator.accessibleText).toBe("dipu is currently running");
  });

  it("a validated scoped live activity run alone renders busy with no association", () => {
    const indicator = workflowStatusIndicator("dipu", { runActive: false, workflow: null }, true);
    expect(indicator.state).toBe("busy");
    expect(indicator.accessibleText).toBe("dipu is currently running");
  });

  it("associated workflow, not low, not exhausted, no run renders none", () => {
    const indicator = workflowStatusIndicator("dipu", BASE, false);
    expect(indicator.state).toBe("none");
  });

  it("associated workflow with run_active and healthy budget renders busy", () => {
    const indicator = workflowStatusIndicator("dipu", { ...BASE, runActive: true }, false);
    expect(indicator.state).toBe("busy");
    expect(indicator.accessibleText).toBe("dipu is currently running");
  });

  it("associated workflow with low budget renders yellow, never masked by busy", () => {
    const snapshot: WorkflowStatusSnapshotView = {
      runActive: true,
      workflow: { effectiveEdges: 10, consumedEdges: 8, low: true, exhausted: false },
    };
    const indicator = workflowStatusIndicator("dipu", snapshot, true);
    expect(indicator.state).toBe("yellow");
    expect(indicator.accessibleText).toBe("Workflow budget low: 2 of 10 handoff edges remaining");
  });

  it("associated workflow exhausted renders red above yellow and busy", () => {
    const snapshot: WorkflowStatusSnapshotView = {
      runActive: true,
      workflow: { effectiveEdges: 10, consumedEdges: 10, low: true, exhausted: true },
    };
    const indicator = workflowStatusIndicator("dipu", snapshot, true);
    expect(indicator.state).toBe("red");
    expect(indicator.accessibleText).toBe(
      "Workflow budget exhausted for dipu's associated workflow; open conversation details to extend",
    );
  });

  it("exhausted persists with run_active false after a gateway restart snapshot", () => {
    const snapshot: WorkflowStatusSnapshotView = {
      runActive: false,
      workflow: { effectiveEdges: 10, consumedEdges: 10, low: true, exhausted: true },
    };
    const indicator = workflowStatusIndicator("dipu", snapshot, false);
    expect(indicator.state).toBe("red");
  });
});

describe("B6 workflow status view model — static representation", () => {
  it("every non-none state carries a non-empty static short text (color/motion never sole carrier)", () => {
    const cases: Array<[WorkflowStatusIndicator["state"], WorkflowStatusIndicator]> = [
      ["red", workflowStatusIndicator("dipu", { ...BASE, workflow: { ...BASE.workflow!, exhausted: true } }, false)],
      ["yellow", workflowStatusIndicator("dipu", { ...BASE, workflow: { ...BASE.workflow!, low: true } }, false)],
      ["busy", workflowStatusIndicator("dipu", { runActive: true, workflow: null }, false)],
    ];
    for (const [state, indicator] of cases) {
      expect(indicator.state).toBe(state);
      expect(indicator.shortText.length).toBeGreaterThan(0);
    }
  });

  it("busy static short text is the reduced-motion-safe word, not a motion description", () => {
    const indicator = workflowStatusIndicator("dipu", { runActive: true, workflow: null }, false);
    expect(indicator.shortText).toBe("running");
  });
});

describe("B6 workflow status view model — live activity transitions between explicit reads", () => {
  const NONE = new Map<string, WorkflowStatusIndicator>([["dipu", workflowStatusIndicator("dipu", { runActive: false, workflow: null }, false)]]);

  it("a working frame transitions none to busy; a settled frame (run leaving the dock) clears it", () => {
    const busy = applyWorkflowStatusActivity(NONE, [{ runId: "r1", agent: "dipu", phase: "working" }]);
    expect(busy.get("dipu")?.state).toBe("busy");
    const cleared = applyWorkflowStatusActivity(busy, []);
    // "none" is represented as an ABSENT entry — no fabricated indicator.
    expect(cleared.has("dipu")).toBe(false);
  });

  it("red and yellow survive both working and settled frames (activity never masks budget states)", () => {
    const redSnapshot: WorkflowStatusSnapshotView = { runActive: false, workflow: { effectiveEdges: 10, consumedEdges: 10, low: true, exhausted: true } };
    const red = new Map<string, WorkflowStatusIndicator>([["dipu", workflowStatusIndicator("dipu", redSnapshot, false)]]);
    const working = applyWorkflowStatusActivity(red, [{ runId: "r1", agent: "dipu", phase: "working" }]);
    expect(working.get("dipu")?.state).toBe("red");
    const settled = applyWorkflowStatusActivity(working, []);
    expect(settled.get("dipu")?.state).toBe("red");
  });

  it("typing counts as an active run", () => {
    const busy = applyWorkflowStatusActivity(NONE, [{ runId: "r1", agent: "dipu", phase: "typing" }]);
    expect(busy.get("dipu")?.state).toBe("busy");
  });
});

describe("B6 workflow status accessible name composition", () => {
  it("inserts the status phrase before the card hint suffix", () => {
    const name = workflowStatusAccessibleName(
      "dipu: Context usage: 30.00% of 200.0k window; activate for details",
      workflowStatusIndicator("dipu", { runActive: true, workflow: null }, false),
    );
    expect(name).toBe("dipu: Context usage: 30.00% of 200.0k window; dipu is currently running; activate for details");
  });

  it("keeps the base name unchanged when there is no indicator", () => {
    const base = "dipu: Context usage: 30.00% of 200.0k window; activate for details";
    expect(workflowStatusAccessibleName(base, undefined)).toBe(base);
    const none = workflowStatusIndicator("dipu", { runActive: false, workflow: null }, false);
    expect(workflowStatusAccessibleName(base, none)).toBe(base);
  });
});

describe("fetchConversationWorkflowStatus transport (B4 exact-pair route)", () => {
  const VALID = {
    run_active: true,
    workflow: {
      root_event_id: "root-1",
      association: "active-run",
      base: { edges: 8, reworkRounds: 2 },
      effective: { edges: 10, reworkRounds: 3 },
      consumed: { edges: 4 },
      worstPairOccurrences: 1,
      low: false,
      exhausted: false,
      warnings: [],
      omittedWarnings: 0,
    },
  };

  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fake = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fake);
    return fake;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the exact encoded authenticated URL and strictly parses the bounded snapshot", async () => {
    const fake = stubFetch(200, VALID);
    const snapshot = await fetchConversationWorkflowStatus("c 1", "agent x", "secret-token");
    expect(snapshot).toEqual({
      runActive: true,
      workflow: {
        rootEventId: "root-1",
        association: "active-run",
        base: { edges: 8, reworkRounds: 2 },
        effective: { edges: 10, reworkRounds: 3 },
        consumed: { edges: 4 },
        worstPairOccurrences: 1,
        low: false,
        exhausted: false,
        warnings: [],
        omittedWarnings: 0,
      },
    });
    expect(fake).toHaveBeenCalledTimes(1);
    const [path, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/conversations/${encodeURIComponent("c 1")}/agents/${encodeURIComponent("agent x")}/workflow-status`);
    expect(init.method).toBeUndefined(); // plain GET
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("parses the workflow-null snapshot exactly", async () => {
    stubFetch(200, { run_active: false, workflow: null });
    const snapshot = await fetchConversationWorkflowStatus("c1", "dipu", "t");
    expect(snapshot).toEqual({ runActive: false, workflow: null });
  });

  it("propagates a 401 as UnauthorizedError (existing onUnauthorized recovery path)", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(fetchConversationWorkflowStatus("c1", "dipu", "stale")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("surfaces a bounded typed error for non-200 statuses", async () => {
    stubFetch(404, { error: "unknown conversation" });
    await expect(fetchConversationWorkflowStatus("c1", "dipu", "t")).rejects.toBeInstanceOf(WorkflowBudgetHttpError);
  });

  it("throws on a malformed payload instead of fabricating facts", async () => {
    stubFetch(200, { run_active: "yes", workflow: null });
    await expect(fetchConversationWorkflowStatus("c1", "dipu", "t")).rejects.toThrow();
    stubFetch(200, { run_active: true, workflow: { exhausted: "no" } });
    await expect(fetchConversationWorkflowStatus("c1", "dipu", "t")).rejects.toThrow();
  });

  it("rejects an incomplete workflow record missing any B4-required field", async () => {
    const FULL = {
      root_event_id: "root-1",
      association: "active-run",
      base: { edges: 8, reworkRounds: 2 },
      effective: { edges: 10, reworkRounds: 3 },
      consumed: { edges: 4 },
      worstPairOccurrences: 1,
      low: false,
      exhausted: false,
      warnings: [],
      omittedWarnings: 0,
    };
    for (const missing of [
      "root_event_id",
      "association",
      "base",
      "effective",
      "consumed",
      "worstPairOccurrences",
      "low",
      "exhausted",
      "warnings",
      "omittedWarnings",
    ]) {
      const partial = { ...FULL } as Record<string, unknown>;
      delete partial[missing];
      stubFetch(200, { run_active: false, workflow: partial });
      await expect(fetchConversationWorkflowStatus("c1", "dipu", "t"), `missing ${missing}`).rejects.toThrow();
    }
  });

  it("rejects unknown own fields at the top level and inside the workflow record", async () => {
    stubFetch(200, { run_active: false, workflow: null, extra: 1 });
    await expect(fetchConversationWorkflowStatus("c1", "dipu", "t")).rejects.toThrow();
    stubFetch(200, {
      run_active: false,
      workflow: {
        root_event_id: "root-1",
        association: "latest-run",
        base: { edges: 8, reworkRounds: 2 },
        effective: { edges: 10, reworkRounds: 3 },
        consumed: { edges: 4 },
        worstPairOccurrences: 1,
        low: false,
        exhausted: false,
        warnings: [],
        omittedWarnings: 0,
        unknown: "x",
      },
    });
    await expect(fetchConversationWorkflowStatus("c1", "dipu", "t")).rejects.toThrow();
  });

  it("rejects malformed dimension/consumed/warnings shapes inside the workflow record", async () => {
    const FULL = {
      root_event_id: "root-1",
      association: "latest-run",
      base: { edges: 8, reworkRounds: 2 },
      effective: { edges: 10, reworkRounds: 3 },
      consumed: { edges: 4 },
      worstPairOccurrences: 1,
      low: false,
      exhausted: false,
      warnings: [],
      omittedWarnings: 0,
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["negative effective edges", { ...FULL, effective: { edges: -1, reworkRounds: 3 } }],
      ["non-integer consumed edges", { ...FULL, consumed: { edges: 1.5 } }],
      ["non-string warning", { ...FULL, warnings: [7] }],
      ["negative omittedWarnings", { ...FULL, omittedWarnings: -1 }],
      ["bad association", { ...FULL, association: "unknown" }],
      ["extra dimension field", { ...FULL, base: { edges: 8, reworkRounds: 2, extra: 1 } }],
      ["consumed with extra field", { ...FULL, consumed: { edges: 4, reworkRounds: 9 } }],
    ];
    for (const [label, workflow] of cases) {
      stubFetch(200, { run_active: false, workflow });
      await expect(fetchConversationWorkflowStatus("c1", "dipu", "t"), label).rejects.toThrow();
    }
  });
});
