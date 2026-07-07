import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimCronJob } from "../src/cron.js";
import {
  buildClaimedCronJobPrompt,
  executeClaimedAgentCronJob,
  parseClaimedCronJobPath,
  type ClaimedCronJobRunInput,
  type ClaimedCronJobRunner,
  type ClaimedCronJobRunnerResult,
} from "../src/scheduler-cron-executor.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-scheduler-cron-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "cron", "jobs"), { recursive: true });
  await mkdir(join(vault, "cron", "runs"), { recursive: true });
  await mkdir(join(vault, "team", "codex", "cron", "jobs"), { recursive: true });
  await mkdir(join(vault, "team", "codex", "cron", "runs"), { recursive: true });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("buildClaimedCronJobPrompt", () => {
  it("includes the exact claimed cron job path, the job id, and the cron prompt body", () => {
    const prompt = buildClaimedCronJobPrompt({
      agentName: "codex",
      jobId: "nightly-digest",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      cronPrompt: "Summarize project logs and flag urgent items.",
    });
    expect(prompt).toContain("cron/jobs/nightly-digest.claimed.heimdall.md");
    expect(prompt).toContain("nightly-digest");
    expect(prompt).toContain("Summarize project logs and flag urgent items.");
  });

  it("tells the agent to stop after one work item", () => {
    const prompt = buildClaimedCronJobPrompt({
      agentName: "codex",
      jobId: "nightly-digest",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      cronPrompt: "Do the thing.",
    });
    expect(prompt).toMatch(/stop after.{0,40}one work item/i);
  });

  it("forbids polling (cron_list/inbox_list)", () => {
    const prompt = buildClaimedCronJobPrompt({
      agentName: "codex",
      jobId: "nightly-digest",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      cronPrompt: "Do the thing.",
    });
    expect(prompt).toMatch(/do not poll/i);
    expect(prompt).toContain("cron_list");
    expect(prompt).toContain("inbox_list");
  });

  it("forbids claiming work (cron_claim/task_claim) and cross-agent fallback", () => {
    const prompt = buildClaimedCronJobPrompt({
      agentName: "codex",
      jobId: "nightly-digest",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      cronPrompt: "Do the thing.",
    });
    expect(prompt).toContain("cron_claim");
    expect(prompt).toContain("task_claim");
    expect(prompt).toMatch(/do not perform cross-agent fallback/i);
  });

  it("tells the agent not to call cron_record_run (scheduler records the run)", () => {
    const prompt = buildClaimedCronJobPrompt({
      agentName: "codex",
      jobId: "nightly-digest",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      cronPrompt: "Do the thing.",
    });
    expect(prompt).toContain("cron_record_run");
  });
});

describe("parseClaimedCronJobPath validation", () => {
  it("returns parsed info for a valid shared claimed cron job path", () => {
    const info = parseClaimedCronJobPath({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
    });
    expect(info).toEqual({
      scope: "shared",
      agentName: "codex",
      deviceId: "heimdall",
      jobId: "nightly-digest",
      fileName: "nightly-digest.md",
      claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
    });
  });

  it("returns parsed info for a valid team-scoped claimed cron job path", () => {
    const info = parseClaimedCronJobPath({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: "team/codex/cron/jobs/check-github.claimed.heimdall.md",
    });
    expect(info.scope).toBe("codex");
    expect(info.deviceId).toBe("heimdall");
    expect(info.jobId).toBe("check-github");
  });

  it("rejects an unclaimed cron job path", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: "cron/jobs/nightly-digest.md",
      }),
    ).toThrow(/\.claimed\./i);
  });

  it("rejects an absolute path inside the vault", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: join(vault, "cron/jobs/nightly-digest.claimed.heimdall.md"),
      }),
    ).toThrow(/vault-relative, not absolute/i);
  });

  it("rejects an absolute path outside the vault", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: join("/etc", "cron/jobs/nightly-digest.claimed.heimdall.md"),
      }),
    ).toThrow(/vault-relative, not absolute/i);
  });

  it("rejects a path that escapes the vault via traversal", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: "../outside/cron/jobs/nightly-digest.claimed.heimdall.md",
      }),
    ).toThrow(/outside the vault/i);
  });

  it("rejects a claimed-looking non-cron path (inbox task)", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: "team/codex/inbox/task-1.claimed.heimdall.md",
      }),
    ).toThrow(/cron\/jobs/i);
  });

  it("rejects a claimed-looking path under cron/runs", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: "cron/runs/nightly-digest.claimed.heimdall.md",
      }),
    ).toThrow(/cron\/jobs/i);
  });

  it("rejects a team-scoped claimed cron job path for a different agent", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: "team/thor/cron/jobs/check-github.claimed.heimdall.md",
      }),
    ).toThrow(/belongs to agent 'thor'/);
  });

  it("rejects an invalid agent name in the input", () => {
    expect(() =>
      parseClaimedCronJobPath({
        vaultRoot: vault,
        agentName: "Bad Agent",
        claimedJobPath: "cron/jobs/nightly-digest.claimed.heimdall.md",
      }),
    ).toThrow(/invalid agent name/i);
  });
});

function agentJobBody(opts: {
  id: string;
  agent?: string;
  prompt?: string;
  mode?: string;
  script?: string;
}): string {
  const agent = opts.agent ?? "codex";
  const mode = opts.mode ?? "agent";
  const lines = ["---", `id: ${opts.id}`, `agent: ${agent}`, 'schedule: "30m"', `mode: ${mode}`];
  if (opts.script) lines.push(`script: ${opts.script}`);
  lines.push("enabled: true", "---", "");
  if (mode === "script") {
    lines.push("# Purpose", "", opts.prompt ?? "script job");
  } else {
    lines.push("# Prompt", "", opts.prompt ?? "Summarize project logs.");
  }
  lines.push("");
  return lines.join("\n");
}

async function writeSharedJob(name: string, content: string): Promise<string> {
  await writeFile(join(vault, "cron", "jobs", `${name}.md`), content);
  return `cron/jobs/${name}.md`;
}

async function writeScopedJob(agent: string, name: string, content: string): Promise<string> {
  await mkdir(join(vault, "team", agent, "cron", "jobs"), { recursive: true });
  await writeFile(join(vault, "team", agent, "cron", "jobs", `${name}.md`), content);
  return `team/${agent}/cron/jobs/${name}.md`;
}

async function claim(path: string, agent = "codex", device = "heimdall"): Promise<string> {
  const r = await claimCronJob({
    vaultRoot: vault,
    jobPath: path,
    deviceId: device,
    agentName: agent,
    now: () => new Date("2026-07-07T08:00:00Z"),
  });
  return r.path;
}

function fakeRunner(
  impl: (input: ClaimedCronJobRunInput) => Promise<ClaimedCronJobRunnerResult> | ClaimedCronJobRunnerResult,
): { runner: ClaimedCronJobRunner; calls: ClaimedCronJobRunInput[] } {
  const calls: ClaimedCronJobRunInput[] = [];
  const runner: ClaimedCronJobRunner = {
    async run(input) {
      calls.push(input);
      return await Promise.resolve(impl(input));
    },
  };
  return { runner, calls };
}

const tick = () => new Date("2026-07-07T08:00:00Z");

describe("executeClaimedAgentCronJob", () => {
  it("runs the agent once, records a completed run, and restores the job", async () => {
    const unclaimed = await writeSharedJob("nightly-digest", agentJobBody({ id: "nightly-digest", prompt: "Summarize project logs." }));
    const claimed = await claim(unclaimed);
    const { runner, calls } = fakeRunner(() => ({ assistantText: "Summarized 3 logs.", exitCode: 0 }));

    const result = await executeClaimedAgentCronJob({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: claimed,
      runner,
      now: tick,
    });

    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.agentName).toBe("codex");
    expect(result.deviceId).toBe("heimdall");
    expect(result.jobId).toBe("nightly-digest");
    expect(result.claimedJobPath).toBe(claimed);
    expect(result.restoredJobPath).toBe(unclaimed);
    expect(result.runRecordPath).toContain("cron/runs/");
    expect("error" in result).toBe(false);

    // Prompt forwarded to the runner includes path, job id, cron prompt, and limits.
    expect(calls[0]?.prompt).toContain(claimed);
    expect(calls[0]?.prompt).toContain("nightly-digest");
    expect(calls[0]?.prompt).toContain("Summarize project logs.");
    expect(calls[0]?.prompt).toMatch(/stop after.{0,40}one work item/i);

    // Run record is inspectable and the job is restored.
    const runContent = await readFile(join(vault, result.runRecordPath), "utf8");
    expect(runContent).toContain("mode: agent");
    expect(runContent).toContain("job_id: nightly-digest");
    expect(runContent).toContain("exit_code: 0");
    expect(runContent).toContain("Summarized 3 logs.");
    expect(runContent).toContain("Summarize project logs.");
    await expect(readFile(join(vault, claimed), "utf8")).rejects.toThrow();
    const restored = await readFile(join(vault, unclaimed), "utf8");
    expect(restored).toContain("last_run: 2026-07-07T08:00:00.000Z");
  });

  it("records a failed run and restores the job on a non-zero runner exit code", async () => {
    const unclaimed = await writeSharedJob("nightly-digest", agentJobBody({ id: "nightly-digest" }));
    const claimed = await claim(unclaimed);
    const { runner } = fakeRunner(() => ({ assistantText: "partial", exitCode: 2 }));

    const result = await executeClaimedAgentCronJob({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: claimed,
      runner,
      now: tick,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(2);
    const runContent = await readFile(join(vault, result.runRecordPath), "utf8");
    expect(runContent).toContain("status: failed");
    expect(runContent).toContain("exit_code: 2");
    await expect(readFile(join(vault, claimed), "utf8")).rejects.toThrow();
    await expect(readFile(join(vault, unclaimed), "utf8")).resolves.toBeDefined();
  });

  it("records a failed run with an error summary and restores the job when the runner throws", async () => {
    const unclaimed = await writeSharedJob("nightly-digest", agentJobBody({ id: "nightly-digest" }));
    const claimed = await claim(unclaimed);
    const { runner } = fakeRunner(() => {
      throw new Error("model provider unreachable");
    });

    const result = await executeClaimedAgentCronJob({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: claimed,
      runner,
      now: tick,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("model provider unreachable");
    const runContent = await readFile(join(vault, result.runRecordPath), "utf8");
    expect(runContent).toContain("status: failed");
    expect(runContent).toContain("model provider unreachable");
    await expect(readFile(join(vault, unclaimed), "utf8")).resolves.toBeDefined();
  });

  it("does not run or record when the frontmatter agent does not match", async () => {
    const unclaimed = await writeSharedJob("nightly-digest", agentJobBody({ id: "nightly-digest", agent: "thor" }));
    const claimed = await claim(unclaimed, "thor");
    const { runner, calls } = fakeRunner(() => ({ assistantText: "x", exitCode: 0 }));

    await expect(
      executeClaimedAgentCronJob({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: claimed,
        runner,
        now: tick,
      }),
    ).rejects.toThrow(/does not match selected agent 'codex'/i);

    expect(calls).toHaveLength(0);
    // No run record was written.
    const runs = await readdir(join(vault, "cron", "runs"));
    expect(runs).toHaveLength(0);
  });

  it("refuses a script-mode cron job without running or recording (script-mode stays on executeScriptCronJob)", async () => {
    await mkdir(join(vault, "scripts"), { recursive: true });
    const scriptAbs = join(vault, "scripts", "disk-check.sh");
    await writeFile(scriptAbs, "#!/bin/sh\necho ok\n");
    const unclaimed = await writeSharedJob(
      "disk-check",
      agentJobBody({ id: "disk-check", mode: "script", script: "scripts/disk-check.sh" }),
    );
    const claimed = await claim(unclaimed);
    const { runner, calls } = fakeRunner(() => ({ assistantText: "x", exitCode: 0 }));

    await expect(
      executeClaimedAgentCronJob({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: claimed,
        runner,
        now: tick,
      }),
    ).rejects.toThrow(/not in agent mode/i);

    expect(calls).toHaveLength(0);
    const runs = await readdir(join(vault, "cron", "runs"));
    expect(runs).toHaveLength(0);
  });

  it("does not run or record for an unclaimed cron job path", async () => {
    const unclaimed = await writeSharedJob("nightly-digest", agentJobBody({ id: "nightly-digest" }));
    const { runner, calls } = fakeRunner(() => ({ assistantText: "x", exitCode: 0 }));

    await expect(
      executeClaimedAgentCronJob({
        vaultRoot: vault,
        agentName: "codex",
        claimedJobPath: unclaimed,
        runner,
        now: tick,
      }),
    ).rejects.toThrow(/\.claimed\./i);

    expect(calls).toHaveLength(0);
    const runs = await readdir(join(vault, "cron", "runs"));
    expect(runs).toHaveLength(0);
  });

  it("executes a team-scoped claimed agent-mode cron job", async () => {
    const unclaimed = await writeScopedJob("codex", "check-github", agentJobBody({ id: "check-github", prompt: "Check open PRs." }));
    const claimed = await claim(unclaimed);
    const { runner, calls } = fakeRunner(() => ({ assistantText: "No new PRs.", exitCode: 0 }));

    const result = await executeClaimedAgentCronJob({
      vaultRoot: vault,
      agentName: "codex",
      claimedJobPath: claimed,
      runner,
      now: tick,
    });

    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.jobId).toBe("check-github");
    expect(result.runRecordPath).toContain("team/codex/cron/runs/");
    expect(result.restoredJobPath).toBe(unclaimed);
  });
});

describe("script-mode cron delegation (S3 stance)", () => {
  it("executeScriptCronJob still records and restores a script-mode job directly (no agent runner)", async () => {
    const { chmod } = await import("node:fs/promises");
    await mkdir(join(vault, "scripts"), { recursive: true });
    const scriptAbs = join(vault, "scripts", "disk-check.sh");
    await writeFile(scriptAbs, "#!/bin/sh\necho agent=$PIREN_AGENT\n", "utf8");
    await chmod(scriptAbs, 0o755);
    const unclaimed = await writeSharedJob(
      "disk-check",
      agentJobBody({ id: "disk-check", mode: "script", script: "scripts/disk-check.sh" }),
    );

    const { executeScriptCronJob } = await import("../src/cron.js");
    const result = await executeScriptCronJob({
      vaultRoot: vault,
      jobPath: unclaimed,
      agentName: "codex",
      deviceId: "heimdall",
      timeoutMs: 2000,
      now: tick,
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.runPath).toContain("cron/runs/");
    const runContent = await readFile(join(vault, result.runPath), "utf8");
    expect(runContent).toContain("mode: script");
    expect(runContent).toContain("agent=codex");
    // Job restored to unclaimed with last_run set.
    await expect(readFile(join(vault, unclaimed), "utf8")).resolves.toContain("last_run:");
  });
});
