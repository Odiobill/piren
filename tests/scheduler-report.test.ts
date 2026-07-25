import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initVault } from "../src/init.js";
import { classifySchedulerReportFindings, formatSchedulerReport, schedulerReport } from "../src/scheduler-report.js";
import type { SchedulerReportFinding } from "../src/scheduler-report.js";

/** Recursive relative-path -> content snapshot, to prove read-only behavior. */
async function snapshotTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(out, await snapshotTree(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out[rel] = await readFile(join(dir, entry.name), "utf8");
    }
  }
  return out;
}
import type { LoadedInboxTask } from "../src/scheduler-dependencies.js";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function task(partial: Partial<LoadedInboxTask> & { id: string; path: string }): LoadedInboxTask {
  return {
    agentName: "thor",
    status: "pending",
    dependsOn: [],
    ...partial,
  };
}

describe("classifySchedulerReportFindings", () => {
  it("reports a claimed inbox task as a manual-triage item without labeling it ambiguous", () => {
    const claimed = task({
      id: "20260725T120000000Z-do-work",
      path: "team/thor/inbox/20260725T120000000Z-do-work.claimed.heimdall.md",
      status: "in_progress",
      claimedBy: "heimdall",
    });

    const findings = classifySchedulerReportFindings({
      pendingTasks: [],
      allTasks: [claimed],
      dependencyNodes: new Map(),
      duplicateIds: new Set(),
      now: NOW,
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.category).toBe("triage");
    expect(finding.agentName).toBe("thor");
    expect(finding.path).toBe(claimed.path);
    // Must say manual triage is required and must NOT claim the task is a
    // proven ambiguous failure: vault state cannot distinguish active,
    // interrupted, or ambiguous (ADR-0038 R3 report boundary).
    expect(finding.reason).toContain("manual triage");
    expect(finding.reason).toContain("heimdall");
    expect(finding.reason).toMatch(/active, interrupted, or ambiguous/);
    expect(finding.reason).not.toMatch(/is an ambiguous failure/);
  });

  it("reports an invalid retry policy with the exact parser reason", () => {
    const invalidPolicy = task({
      id: "20260725T120000000Z-bad-retry",
      path: "team/thor/inbox/20260725T120000000Z-bad-retry.md",
      frontmatter: {
        id: "20260725T120000000Z-bad-retry",
        status: "pending",
        retry: { safe_to_retry: false, max_attempts: 2, backoff_seconds: 60 },
      },
    });

    const findings = classifySchedulerReportFindings({
      pendingTasks: [invalidPolicy],
      allTasks: [invalidPolicy],
      dependencyNodes: new Map(),
      duplicateIds: new Set(),
      now: NOW,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "retry",
      agentName: "thor",
      path: invalidPolicy.path,
      reason: "retry policy requires safe_to_retry: true",
    });
  });

  it("reports a malformed retry_state with the exact parser reason", () => {
    const malformedState = task({
      id: "20260725T120000000Z-bad-state",
      path: "team/thor/inbox/20260725T120000000Z-bad-state.md",
      frontmatter: {
        id: "20260725T120000000Z-bad-state",
        status: "pending",
        retry: { safe_to_retry: true, max_attempts: 2, backoff_seconds: 60 },
        retry_state: { attempts: 1 },
      },
    });

    const findings = classifySchedulerReportFindings({
      pendingTasks: [malformedState],
      allTasks: [malformedState],
      dependencyNodes: new Map(),
      duplicateIds: new Set(),
      now: NOW,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "retry",
      reason: "retry_state.last_attempt_at must be an ISO timestamp",
    });
  });

  it("reports exhausted retry attempts on a claimed task with the existing exhaustion wording", () => {
    // R2 rewrites the final exhausted state into the CLAIMED file, so the
    // report must inspect claimed files too, not only pending candidates.
    const exhausted = task({
      id: "20260725T120000000Z-exhausted",
      path: "team/thor/inbox/20260725T120000000Z-exhausted.claimed.heimdall.md",
      status: "pending",
      claimedBy: "heimdall",
      frontmatter: {
        id: "20260725T120000000Z-exhausted",
        status: "pending",
        retry: { safe_to_retry: true, max_attempts: 2, backoff_seconds: 60 },
        retry_state: {
          attempts: 2,
          last_attempt_at: "2026-07-25T11:00:00.000Z",
          next_eligible_at: "2026-07-25T11:01:00.000Z",
          last_failure: "launch_failure",
        },
      },
    });

    const findings = classifySchedulerReportFindings({
      pendingTasks: [],
      allTasks: [exhausted],
      dependencyNodes: new Map(),
      duplicateIds: new Set(),
      now: NOW,
    });

    const retryFinding = findings.find((f) => f.category === "retry");
    expect(retryFinding).toMatchObject({
      path: exhausted.path,
      reason: "retry attempts exhausted (2/2)",
    });
    // The same file is also a claimed manual-triage item.
    expect(findings.some((f) => f.category === "triage" && f.path === exhausted.path)).toBe(true);
  });

  it("does not report unexpired backoff or healthy retry state", () => {
    const backoff = task({
      id: "20260725T120000000Z-backoff",
      path: "team/thor/inbox/20260725T120000000Z-backoff.md",
      frontmatter: {
        id: "20260725T120000000Z-backoff",
        status: "pending",
        retry: { safe_to_retry: true, max_attempts: 3, backoff_seconds: 3600 },
        retry_state: {
          attempts: 1,
          last_attempt_at: "2026-07-25T11:00:00.000Z",
          next_eligible_at: "2026-07-25T13:00:00.000Z",
          last_failure: "launch_failure",
        },
      },
    });

    const findings = classifySchedulerReportFindings({
      pendingTasks: [backoff],
      allTasks: [backoff],
      dependencyNodes: new Map(),
      duplicateIds: new Set(),
      now: NOW,
    });

    expect(findings).toHaveLength(0);
  });

  it("orders findings deterministically (agent, category, path) and deduplicates", () => {
    const triageZ = task({
      id: "20260725T120000000Z-z",
      path: "team/thor/inbox/20260725T120000000Z-z.claimed.heimdall.md",
      claimedBy: "heimdall",
    });
    const triageA = task({
      id: "20260725T120000000Z-a",
      path: "team/thor/inbox/20260725T120000000Z-a.claimed.heimdall.md",
      claimedBy: "heimdall",
    });
    const retryTask = task({
      id: "20260725T120000000Z-bad-retry",
      path: "team/thor/inbox/20260725T120000000Z-bad-retry.md",
      frontmatter: { retry: null },
    });

    const run = () =>
      classifySchedulerReportFindings({
        pendingTasks: [],
        // Intentionally unsorted, with a duplicate entry.
        allTasks: [triageZ, retryTask, triageA, triageZ],
        dependencyNodes: new Map(),
        duplicateIds: new Set(),
        now: NOW,
      });

    const findings = run();
    expect(findings.map((f) => `${f.category}:${f.path}`)).toEqual([
      `retry:${retryTask.path}`,
      `triage:${triageA.path}`,
      `triage:${triageZ.path}`,
    ]);
    // Same input -> identical output (stable across runs).
    expect(run()).toEqual(findings);
  });

  it("reports dependency cycles involving pending candidates with the exact evaluator reason", () => {
    const idA = "20260725T120000000Z-cycle-a";
    const idB = "20260725T120000000Z-cycle-b";
    const a = task({ id: idA, path: `team/thor/inbox/${idA}.md`, dependsOn: [idB] });
    const b = task({ id: idB, path: `team/thor/inbox/${idB}.md`, dependsOn: [idA] });
    const dependencyNodes = new Map([
      [idA, { id: idA, status: "pending" as const, dependsOn: [idB], path: a.path }],
      [idB, { id: idB, status: "pending" as const, dependsOn: [idA], path: b.path }],
    ]);

    const findings = classifySchedulerReportFindings({
      pendingTasks: [a, b],
      allTasks: [a, b],
      dependencyNodes,
      duplicateIds: new Set(),
      now: NOW,
    });

    const cycles = findings.filter((f) => f.category === "cycle");
    expect(cycles).toHaveLength(2);
    expect(cycles.map((f) => f.reason)).toEqual([
      `dependency cycle: ${idA} -> ${idB} -> ${idA}`,
      `dependency cycle: ${idB} -> ${idA} -> ${idB}`,
    ]);
  });

  it("does not report non-cycle dependency blocks (missing/unsatisfied stay in --dry-run)", () => {
    const blocked = task({
      id: "20260725T120000000Z-blocked",
      path: "team/thor/inbox/20260725T120000000Z-blocked.md",
      dependsOn: ["20260725T120000000Z-missing"],
    });

    const findings = classifySchedulerReportFindings({
      pendingTasks: [blocked],
      allTasks: [blocked],
      dependencyNodes: new Map(),
      duplicateIds: new Set(),
      now: NOW,
    });

    expect(findings).toHaveLength(0);
  });
});

describe("formatSchedulerReport", () => {
  it("groups findings by agent in enabled-agent order with category tags and a summary", () => {
    const findings: SchedulerReportFinding[] = [
      {
        category: "triage",
        agentName: "thor",
        path: "team/thor/inbox/t.claimed.heimdall.md",
        reason: "claimed by heimdall; requires manual triage: may be active, interrupted, or ambiguous — vault state alone cannot tell",
      },
      { category: "retry", agentName: "thor", path: "team/thor/inbox/r.md", reason: "retry attempts exhausted (2/2)" },
      { category: "cycle", agentName: "nora", path: "team/nora/inbox/a.md", reason: "dependency cycle: a -> b -> a" },
    ];

    const output = formatSchedulerReport(["thor", "nora", "zai"], findings);

    expect(output.startsWith("SCHEDULER REPORT")).toBe(true);
    // Enabled-agent order preserved; agent with no findings is explicit.
    expect(output.indexOf("agent: thor")).toBeLessThan(output.indexOf("agent: nora"));
    expect(output.indexOf("agent: nora")).toBeLessThan(output.indexOf("agent: zai"));
    expect(output).toContain("[CYCLE]");
    expect(output).toContain("[RETRY]");
    expect(output).toContain("[TRIAGE]");
    expect(output).toContain("(no findings)");
    // Summary line counts findings by category.
    expect(output).toMatch(/3 findings/);
    expect(output).toMatch(/1 cycle/);
    expect(output).toMatch(/1 retry/);
    expect(output).toMatch(/1 manual-triage/);
  });

  it("states the read-only guarantee and the ambiguity limitation", () => {
    const output = formatSchedulerReport(["thor"], []);
    expect(output).toMatch(/read-only/);
    expect(output).toMatch(/claimed task requires manual triage/i);
    expect(output).toMatch(/active, interrupted, or ambiguous/);
    expect(output).toContain("0 findings");
  });
});

describe("schedulerReport (orchestration)", () => {
  let root: string;
  let vault: string;
  let configPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-scheduler-report-"));
    vault = join(root, "vault");
    configPath = join(root, "config.yml");
    await initVault({ vaultRoot: vault, agentName: "thor" });
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("reports a friendly message when no vault root is configured", async () => {
    await writeFile(configPath, "allowed_agents:\n  - thor\n");
    const output = await schedulerReport({ configPath });
    expect(output).toContain("SCHEDULER REPORT");
    expect(output).toMatch(/no vault root/i);
  });

  it("reports a friendly message when no agents are enabled", async () => {
    await writeFile(configPath, `vault_root: ${vault}\n`);
    const output = await schedulerReport({ configPath });
    expect(output).toContain("SCHEDULER REPORT");
    expect(output).toMatch(/no enabled agents/i);
  });

  it("scopes findings to allowed_agents minus excluded_agents", async () => {
    await mkdir(join(vault, "team", "nora", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "nora", "inbox", "20260725T120000000Z-nora-task.claimed.heimdall.md"),
      "---\nid: 20260725T120000000Z-nora-task\nstatus: pending\n---\n\n# Nora task\n",
    );
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "inbox", "20260725T120000000Z-thor-task.claimed.heimdall.md"),
      "---\nid: 20260725T120000000Z-thor-task\nstatus: pending\n---\n\n# Thor task\n",
    );
    await writeFile(
      configPath,
      `vault_root: ${vault}\nallowed_agents:\n  - thor\n  - nora\nexcluded_agents:\n  - nora\n`,
    );

    const output = await schedulerReport({ configPath });

    expect(output).toContain("agent: thor");
    expect(output).toContain("20260725T120000000Z-thor-task.claimed.heimdall.md");
    expect(output).not.toContain("nora");
  });

  it("surfaces a claimed exhausted task end-to-end and never writes to the vault", async () => {
    const claimedPath = join(
      vault, "team", "thor", "inbox", "20260725T120000000Z-exhausted.claimed.heimdall.md",
    );
    await mkdir(join(vault, "team", "thor", "inbox"), { recursive: true });
    const claimedContent =
      "---\n" +
      "id: 20260725T120000000Z-exhausted\n" +
      "status: pending\n" +
      "retry:\n" +
      "  safe_to_retry: true\n" +
      "  max_attempts: 2\n" +
      "  backoff_seconds: 60\n" +
      "retry_state:\n" +
      "  attempts: 2\n" +
      "  last_attempt_at: \"2026-07-25T11:00:00.000Z\"\n" +
      "  next_eligible_at: \"2026-07-25T11:01:00.000Z\"\n" +
      "  last_failure: launch_failure\n" +
      "---\n\n# Exhausted task\n";
    await writeFile(claimedPath, claimedContent);
    await writeFile(configPath, `vault_root: ${vault}\nallowed_agents:\n  - thor\n`);

    const before = await snapshotTree(vault);
    const output = await schedulerReport({ configPath });
    const after = await snapshotTree(vault);

    expect(output).toContain("[RETRY]");
    expect(output).toContain("retry attempts exhausted (2/2)");
    expect(output).toContain("[TRIAGE]");
    expect(output).toContain("manual triage");
    // Read-only guarantee: the vault tree is byte-for-byte unchanged.
    expect(after).toEqual(before);
    expect(await readFile(claimedPath, "utf8")).toBe(claimedContent);
  });
});
