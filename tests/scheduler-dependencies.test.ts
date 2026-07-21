import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TASK_ID_PATTERN,
  extractDependsOn,
  parseDependencyTaskNode,
  evaluateTaskDependencyEligibility,
  loadInboxDependencyNodes,
  loadSchedulerInboxState,
  type DependencyTaskNode,
} from "../src/scheduler-dependencies.js";

const IMPL = "20260721T120000000Z-implement-slice";
const REVIEW = "20260721T130000000Z-review-slice";
const DEPLOY = "20260721T140000000Z-deploy-step";
const OTHER = "20260721T150000000Z-unrelated-task";

/** Build a dependency node without tripping exactOptionalPropertyTypes. */
function node(opts: {
  id: string;
  status?: "pending" | "in_progress" | "completed" | "cancelled";
  dependsOn?: string[];
  path?: string;
  dependsOnError?: string;
}): DependencyTaskNode {
  const n: DependencyTaskNode = {
    id: opts.id,
    status: opts.status ?? "pending",
    dependsOn: opts.dependsOn ?? [],
    path: opts.path ?? `team/codex/inbox/${opts.id}.md`,
  };
  if (opts.dependsOnError !== undefined) n.dependsOnError = opts.dependsOnError;
  return n;
}

function nodes(...list: DependencyTaskNode[]): Map<string, DependencyTaskNode> {
  const map = new Map<string, DependencyTaskNode>();
  for (const n of list) map.set(n.id, n);
  return map;
}

describe("TASK_ID_PATTERN", () => {
  it("matches generated task IDs", () => {
    expect(TASK_ID_PATTERN.test(IMPL)).toBe(true);
    expect(TASK_ID_PATTERN.test("20260715T191953168Z-implement-slice-d-piren-skill-foundation-cli")).toBe(true);
  });

  it("rejects non-matching ids", () => {
    expect(TASK_ID_PATTERN.test("not-a-task-id")).toBe(false);
    expect(TASK_ID_PATTERN.test("20260721T120000000Z")).toBe(false); // missing slug
    expect(TASK_ID_PATTERN.test("20260721T120000000Z-UPPER")).toBe(false); // uppercase slug
    expect(TASK_ID_PATTERN.test("team/codex/inbox/x.md")).toBe(false); // a path, not an id
  });
});

describe("extractDependsOn", () => {
  it("returns empty ids when absent", () => {
    expect(extractDependsOn({})).toEqual({ ids: [] });
  });

  it("returns the sequence of strings", () => {
    expect(extractDependsOn({ depends_on: [IMPL, REVIEW] })).toEqual({ ids: [IMPL, REVIEW] });
  });

  it("errors when depends_on is not a sequence", () => {
    const r = extractDependsOn({ depends_on: IMPL });
    expect(r.ids).toEqual([]);
    expect(r.error).toBeDefined();
  });

  it("errors when a sequence element is not a string", () => {
    const r = extractDependsOn({ depends_on: [IMPL, 42] });
    expect(r.ids).toEqual([]);
    expect(r.error).toBeDefined();
  });

  it("trims and drops empty entries", () => {
    expect(extractDependsOn({ depends_on: ["  " + IMPL + "  ", "  "] })).toEqual({ ids: [IMPL] });
  });
});

describe("evaluateTaskDependencyEligibility", () => {
  it("is eligible when the task has no dependencies", () => {
    const candidate = node({ id: IMPL });
    expect(evaluateTaskDependencyEligibility(candidate, nodes())).toEqual({ eligible: true });
  });

  it("is eligible when every prerequisite is completed", () => {
    const candidate = node({ id: REVIEW, dependsOn: [IMPL] });
    const map = nodes(candidate, node({ id: IMPL, status: "completed" }));
    expect(evaluateTaskDependencyEligibility(candidate, map)).toEqual({ eligible: true });
  });

  it("blocks a malformed dependency id", () => {
    const candidate = node({ id: REVIEW, dependsOn: ["not-a-valid-id"] });
    const verdict = evaluateTaskDependencyEligibility(candidate, nodes(candidate));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("malformed");
    expect(verdict.reason).toContain("not-a-valid-id");
  });

  it("blocks duplicate dependency ids", () => {
    const candidate = node({ id: REVIEW, dependsOn: [IMPL, IMPL] });
    const map = nodes(candidate, node({ id: IMPL, status: "completed" }));
    const verdict = evaluateTaskDependencyEligibility(candidate, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("duplicate");
    expect(verdict.reason).toContain(IMPL);
  });

  it("blocks a self-dependency", () => {
    const candidate = node({ id: REVIEW, dependsOn: [REVIEW] });
    const verdict = evaluateTaskDependencyEligibility(candidate, nodes(candidate));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("self");
    expect(verdict.reason).toContain(REVIEW);
  });

  it("blocks a missing dependency target", () => {
    const candidate = node({ id: REVIEW, dependsOn: [IMPL] });
    const verdict = evaluateTaskDependencyEligibility(candidate, nodes(candidate));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("missing");
    expect(verdict.reason).toContain(IMPL);
  });

  it("blocks a dependency cycle", () => {
    // REVIEW -> IMPL -> REVIEW
    const review = node({ id: REVIEW, dependsOn: [IMPL] });
    const impl = node({ id: IMPL, dependsOn: [REVIEW] });
    const map = nodes(review, impl);
    const verdict = evaluateTaskDependencyEligibility(review, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("cycle");
    expect(verdict.reason).toContain(REVIEW);
    expect(verdict.reason).toContain(IMPL);
  });

  it("blocks a longer dependency cycle", () => {
    // DEPLOY -> REVIEW -> IMPL -> DEPLOY
    const deploy = node({ id: DEPLOY, dependsOn: [REVIEW] });
    const review = node({ id: REVIEW, dependsOn: [IMPL] });
    const impl = node({ id: IMPL, dependsOn: [DEPLOY] });
    const map = nodes(deploy, review, impl);
    const verdict = evaluateTaskDependencyEligibility(deploy, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("cycle");
  });

  it("does not report a cycle for a task that merely depends on a cyclic pair", () => {
    // OTHER -> REVIEW; REVIEW <-> IMPL (cycle). OTHER is not itself in a cycle;
    // it is blocked by the unsatisfied REVIEW instead.
    const other = node({ id: OTHER, dependsOn: [REVIEW] });
    const review = node({ id: REVIEW, dependsOn: [IMPL] });
    const impl = node({ id: IMPL, dependsOn: [REVIEW] });
    const map = nodes(other, review, impl);
    const verdict = evaluateTaskDependencyEligibility(other, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("unsatisfied");
    expect(verdict.reason).not.toContain("cycle");
  });

  it("blocks an unsatisfied prerequisite that is pending", () => {
    const candidate = node({ id: REVIEW, dependsOn: [IMPL] });
    const map = nodes(candidate, node({ id: IMPL, status: "pending" }));
    const verdict = evaluateTaskDependencyEligibility(candidate, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("unsatisfied");
    expect(verdict.reason).toContain(IMPL);
    expect(verdict.reason).toContain("pending");
  });

  it("blocks an unsatisfied prerequisite that is in_progress", () => {
    const candidate = node({ id: REVIEW, dependsOn: [IMPL] });
    const map = nodes(candidate, node({ id: IMPL, status: "in_progress" }));
    const verdict = evaluateTaskDependencyEligibility(candidate, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("in_progress");
  });

  it("blocks a cancelled prerequisite (only completed satisfies)", () => {
    const candidate = node({ id: REVIEW, dependsOn: [IMPL] });
    const map = nodes(candidate, node({ id: IMPL, status: "cancelled" }));
    const verdict = evaluateTaskDependencyEligibility(candidate, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("cancelled");
  });

  it("blocks when any of multiple prerequisites is unsatisfied", () => {
    const candidate = node({ id: DEPLOY, dependsOn: [IMPL, REVIEW] });
    const map = nodes(
      candidate,
      node({ id: IMPL, status: "completed" }),
      node({ id: REVIEW, status: "pending" }),
    );
    const verdict = evaluateTaskDependencyEligibility(candidate, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain(REVIEW);
  });

  it("resolves a cross-agent prerequisite through the shared node map", () => {
    // REVIEW lives in codex's inbox but depends on an IMPL task owned by dipu.
    const candidate = node({ id: REVIEW, dependsOn: [IMPL], path: "team/codex/inbox/review.md" });
    const map = nodes(candidate, node({ id: IMPL, status: "completed", path: "team/dipu/inbox/impl.md" }));
    expect(evaluateTaskDependencyEligibility(candidate, map)).toEqual({ eligible: true });
  });

  it("treats a claimed (pending) prerequisite as unsatisfied, not missing", () => {
    // The prerequisite is a claimed file: status still pending, never completed.
    const candidate = node({ id: REVIEW, dependsOn: [IMPL] });
    const claimedImpl = node({ id: IMPL, status: "pending", path: "team/codex/inbox/impl.claimed.heimdall.md" });
    const map = nodes(candidate, claimedImpl);
    const verdict = evaluateTaskDependencyEligibility(candidate, map);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("unsatisfied");
    expect(verdict.reason).not.toContain("missing");
  });

  it("blocks a task whose depends_on declaration is malformed", () => {
    const candidate = node({ id: REVIEW, dependsOnError: "depends_on must be a sequence of task IDs" });
    const verdict = evaluateTaskDependencyEligibility(candidate, nodes(candidate));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("depends_on");
  });
});

describe("parseDependencyTaskNode", () => {
  it("parses id, status, and depends_on from frontmatter", () => {
    const content = [
      "---",
      `id: ${REVIEW}`,
      "status: pending",
      "depends_on:",
      `  - ${IMPL}`,
      "---",
      "",
      "# Review",
    ].join("\n");
    const parsed = parseDependencyTaskNode(content, "team/codex/inbox/review.md");
    expect(parsed).toBeDefined();
    expect(parsed?.id).toBe(REVIEW);
    expect(parsed?.status).toBe("pending");
    expect(parsed?.dependsOn).toEqual([IMPL]);
  });

  it("parses a completed task with no dependencies", () => {
    const content = ["---", `id: ${IMPL}`, "status: completed", "---", "", "# Impl"].join("\n");
    const parsed = parseDependencyTaskNode(content, "team/codex/inbox/impl.md");
    expect(parsed?.id).toBe(IMPL);
    expect(parsed?.status).toBe("completed");
    expect(parsed?.dependsOn).toEqual([]);
  });

  it("returns undefined when frontmatter is missing", () => {
    expect(parseDependencyTaskNode("# no frontmatter", "x.md")).toBeUndefined();
  });

  it("returns undefined when id is missing", () => {
    const content = ["---", "status: pending", "---", "", "# x"].join("\n");
    expect(parseDependencyTaskNode(content, "x.md")).toBeUndefined();
  });

  it("returns undefined when status is invalid", () => {
    const content = ["---", `id: ${REVIEW}`, "status: weird", "---", "", "# x"].join("\n");
    expect(parseDependencyTaskNode(content, "x.md")).toBeUndefined();
  });

  it("flags a malformed depends_on declaration without dropping the task", () => {
    const content = ["---", `id: ${REVIEW}`, "status: pending", `depends_on: ${IMPL}`, "---", "", "# x"].join("\n");
    const parsed = parseDependencyTaskNode(content, "x.md");
    expect(parsed).toBeDefined();
    expect(parsed?.dependsOnError).toBeDefined();
    expect(parsed?.dependsOn).toEqual([]);
  });
});

describe("loadInboxDependencyNodes", () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "piren-deps-load-"));
  });
  afterEach(async () => rm(vault, { recursive: true, force: true }));

  it("reads ordinary and claimed inbox files", async () => {
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "codex", "inbox", `${IMPL}.md`),
      ["---", `id: ${IMPL}`, "status: pending", "---", "", "# Impl"].join("\n"),
    );
    // A claimed prerequisite: status still pending, claimed filename.
    await writeFile(
      join(vault, "team", "codex", "inbox", `${REVIEW}.claimed.heimdall.md`),
      ["---", `id: ${REVIEW}`, "status: pending", "---", "", "# Review"].join("\n"),
    );

    const loaded = await loadInboxDependencyNodes({ vaultRoot: vault, agentName: "codex" });
    const ids = loaded.map((t) => t.id).sort();
    expect(ids).toEqual([IMPL, REVIEW].sort());
    const review = loaded.find((t) => t.id === REVIEW);
    expect(review?.claimedBy).toBe("heimdall");
    const impl = loaded.find((t) => t.id === IMPL);
    expect(impl?.claimedBy).toBeUndefined();
  });

  it("parses depends_on from the loaded files", async () => {
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "codex", "inbox", `${REVIEW}.md`),
      ["---", `id: ${REVIEW}`, "status: pending", "depends_on:", `  - ${IMPL}`, "---", "", "# Review"].join("\n"),
    );

    const loaded = await loadInboxDependencyNodes({ vaultRoot: vault, agentName: "codex" });
    const review = loaded.find((t) => t.id === REVIEW);
    expect(review?.dependsOn).toEqual([IMPL]);
  });
});

describe("loadSchedulerInboxState", () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "piren-deps-state-"));
  });
  afterEach(async () => rm(vault, { recursive: true, force: true }));

  it("builds a resolver map across agents and pending candidates", async () => {
    // codex has a completed impl task; dipu has a pending review that depends on it.
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    await mkdir(join(vault, "team", "dipu", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "codex", "inbox", `${IMPL}.md`),
      ["---", `id: ${IMPL}`, "status: completed", "from: nora", "to: codex", "created: x", "updated: x", "---", "", "# Impl"].join("\n"),
    );
    await writeFile(
      join(vault, "team", "dipu", "inbox", `${REVIEW}.md`),
      ["---", `id: ${REVIEW}`, "status: pending", "depends_on:", `  - ${IMPL}`, "from: nora", "to: dipu", "created: x", "updated: x", "---", "", "# Review"].join("\n"),
    );

    const state = await loadSchedulerInboxState({ vaultRoot: vault, enabledAgents: ["codex", "dipu"] });
    expect(state.dependencyNodes.has(IMPL)).toBe(true);
    expect(state.dependencyNodes.has(REVIEW)).toBe(true);
    // Only the pending, unclaimed review is a candidate.
    expect(state.pendingTasks.map((t) => t.id).sort()).toEqual([REVIEW]);
    expect(state.pendingTasks[0]?.dependsOn).toEqual([IMPL]);
  });

  it("includes claimed files in the resolver but not in candidates", async () => {
    await mkdir(join(vault, "team", "codex", "inbox"), { recursive: true });
    await writeFile(
      join(vault, "team", "codex", "inbox", `${IMPL}.claimed.heimdall.md`),
      ["---", `id: ${IMPL}`, "status: pending", "---", "", "# Impl"].join("\n"),
    );

    const state = await loadSchedulerInboxState({ vaultRoot: vault, enabledAgents: ["codex"] });
    expect(state.dependencyNodes.has(IMPL)).toBe(true); // resolves (so not "missing")
    expect(state.pendingTasks).toEqual([]); // claimed -> not a candidate
  });

  it("skips agents whose inbox directory is missing", async () => {
    const state = await loadSchedulerInboxState({ vaultRoot: vault, enabledAgents: ["ghost"] });
    expect(state.dependencyNodes.size).toBe(0);
    expect(state.pendingTasks).toEqual([]);
  });
});
