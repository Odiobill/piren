import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  isValidCronId,
  renderCronJobFrontmatter,
  createCronJob,
  createScriptCronJob,
  enableCronJob,
  disableCronJob,
  validateCronJobs,
  formatCronList,
  formatCronShow,
  formatCronRuns,
  formatCronValidationReport,
  resolveCronJobPath,
  readCronJobFile,
  type CronWriteDeps,
  type CronJobWriteSpec,
  type CronValidationIssue,
  type CronJobFile,
} from "../src/cron-cli.js";

// ---------------------------------------------------------------------------
// Fake filesystem for injected deps.
// ---------------------------------------------------------------------------

interface FakeEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

class FakeFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  private _entries = new Map<string, FakeEntry[]>();

  constructor() {
    this.dirs.add("");
    this.dirs.add("/");
  }

  private norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private registerParents(p: string): void {
    const parts = p.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length; i += 1) {
      acc += "/" + parts[i];
      this.dirs.add(acc);
    }
  }

  file(path: string, content: string): this {
    const p = this.norm(path);
    this.files.set(p, content);
    this.registerParents(p);
    // Update parent dir entries
    const parent = p.substring(0, p.lastIndexOf("/")) || "/";
    const name = p.substring(p.lastIndexOf("/") + 1);
    let entries = this._entries.get(parent) ?? [];
    entries = entries.filter((e) => e.name !== name);
    entries.push({ name, isDirectory: () => false, isFile: () => true });
    this._entries.set(parent, entries);
    return this;
  }

  dir(path: string): this {
    const p = this.norm(path);
    this.dirs.add(p);
    this.registerParents(p);
    const parent = p.substring(0, p.lastIndexOf("/")) || "/";
    const name = p.substring(p.lastIndexOf("/") + 1);
    let entries = this._entries.get(parent) ?? [];
    entries = entries.filter((e) => e.name !== name);
    entries.push({ name, isDirectory: () => true, isFile: () => false });
    this._entries.set(parent, entries);
    return this;
  }

  async readFile(path: string): Promise<string> {
    const p = this.norm(path);
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = this.norm(path);
    this.files.set(p, content);
    this.registerParents(p);
    // Update parent entries
    const parent = p.substring(0, p.lastIndexOf("/")) || "/";
    const name = p.substring(p.lastIndexOf("/") + 1);
    let entries = this._entries.get(parent) ?? [];
    entries = entries.filter((e) => e.name !== name);
    entries.push({ name, isDirectory: () => false, isFile: () => true });
    this._entries.set(parent, entries);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    const p = this.norm(path);
    this.dirs.add(p);
    this.registerParents(p);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean }> {
    const p = this.norm(path);
    if (this.dirs.has(p)) return { isDirectory: () => true };
    // Must also check files before throwing
    if (this.files.has(p)) return { isDirectory: () => false };
    throw new Error(`ENOENT: no such file: ${path}`);
  }

  async readdir(path: string): Promise<FakeEntry[]> {
    const p = this.norm(path);
    if (!this.dirs.has(p)) throw new Error(`ENOENT: no such directory: ${path}`);
    return this._entries.get(p) ?? [];
  }
}

function makeDeps(fs: FakeFs): CronWriteDeps {
  return {
    readFile: (path: string) => fs.readFile(path),
    writeFile: (path: string, content: string) => fs.writeFile(path, content),
    mkdir: (path: string, opts?: { recursive?: boolean }) => fs.mkdir(path, opts),
    stat: (path: string) => fs.stat(path),
    readdir: (path: string) => fs.readdir(path),
  };
}

// ---------------------------------------------------------------------------
// isValidCronId
// ---------------------------------------------------------------------------

describe("isValidCronId", () => {
  it("accepts plain kebab-case ids", () => {
    expect(isValidCronId("nightly-digest")).toBe(true);
  });

  it("accepts simple alphanumeric ids", () => {
    expect(isValidCronId("cleanup")).toBe(true);
  });

  it("rejects path separators", () => {
    expect(isValidCronId("foo/bar")).toBe(false);
    expect(isValidCronId("foo\\bar")).toBe(false);
  });

  it("rejects . and ..", () => {
    expect(isValidCronId(".")).toBe(false);
    expect(isValidCronId("..")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isValidCronId("")).toBe(false);
  });

  it("accepts ids with underscores", () => {
    expect(isValidCronId("nightly_digest")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderCronJobFrontmatter
// ---------------------------------------------------------------------------

describe("renderCronJobFrontmatter", () => {
  it("produces valid YAML with all required fields for agent mode", () => {
    const rendered = renderCronJobFrontmatter({
      id: "test-job",
      agent: "piren",
      schedule: "0 7 * * *",
      mode: "agent",
      body: "# Prompt\n\nDo the thing.",
    });
    expect(rendered).toContain("id: test-job");
    expect(rendered).toContain("agent: piren");
    expect(rendered).toContain("schedule: '0 7 * * *'");
    expect(rendered).toContain("mode: agent");
    expect(rendered).toContain("enabled: true");
    expect(rendered).toContain("stale_after_seconds: 300");
    expect(rendered).toContain("last_run: null");
    expect(rendered).toContain("last_claimed_by: null");
  });

  it("produces valid YAML for script mode", () => {
    const rendered = renderCronJobFrontmatter({
      id: "backup",
      agent: "piren",
      schedule: "0 2 * * *",
      mode: "script",
      script: "scripts/backup.sh",
      body: "# Prompt\n\nRuns backup.",
    });
    expect(rendered).toContain("mode: script");
    expect(rendered).toContain("script: scripts/backup.sh");
  });

  it("includes the body after frontmatter", () => {
    const rendered = renderCronJobFrontmatter({
      id: "test",
      agent: "piren",
      schedule: "30m",
      mode: "agent",
      body: "# Prompt\n\nCustom instructions here.",
    });
    expect(rendered).toContain("Custom instructions here.");
  });

  it("generates a default placeholder body when none provided", () => {
    const rendered = renderCronJobFrontmatter({
      id: "test",
      agent: "piren",
      schedule: "1d",
      mode: "agent",
    });
    expect(rendered).toContain("TODO: add instructions");
  });

  it("rejects an invalid schedule", () => {
    expect(() =>
      renderCronJobFrontmatter({
        id: "test",
        agent: "piren",
        schedule: "not-a-schedule",
        mode: "agent",
      }),
    ).toThrow(/Invalid cron schedule/);
  });

  it("emits type: Cron Job in frontmatter", () => {
    const rendered = renderCronJobFrontmatter({
      id: "test",
      agent: "piren",
      schedule: "30m",
      mode: "agent",
    });
    expect(rendered).toContain("type: Cron Job");
  });
});

// ---------------------------------------------------------------------------
// createCronJob
// ---------------------------------------------------------------------------

describe("createCronJob", () => {
  const vaultRoot = "/vault";

  it("writes a job to the correct agent-scoped path", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await createCronJob(deps, vaultRoot, "test-job", "piren", "0 7 * * *");
    const content = await deps.readFile(join(vaultRoot, "team/piren/cron/jobs/test-job.md"));
    expect(content).toContain("id: test-job");
    expect(content).toContain("agent: piren");
    expect(content).toContain("mode: agent");
  });

  it("refuses to overwrite an existing job without --force", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "team", "piren", "cron", "jobs"));
    await deps.writeFile(join(vaultRoot, "team/piren/cron/jobs/test-job.md"), "existing");
    await expect(createCronJob(deps, vaultRoot, "test-job", "piren", "30m")).rejects.toThrow(
      /already exists/,
    );
  });

  it("overwrites an existing job with --force", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "team", "piren", "cron", "jobs"));
    await deps.writeFile(join(vaultRoot, "team/piren/cron/jobs/test-job.md"), "existing");
    await createCronJob(deps, vaultRoot, "test-job", "piren", "30m", undefined, { force: true });
    const content = await deps.readFile(join(vaultRoot, "team/piren/cron/jobs/test-job.md"));
    expect(content).toContain("id: test-job");
  });

  it("validates the schedule expression", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(createCronJob(deps, vaultRoot, "job", "piren", "bad")).rejects.toThrow(
      /Invalid cron schedule/,
    );
  });

  it("validates the job id", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(createCronJob(deps, vaultRoot, "", "piren", "30m")).rejects.toThrow();
    await expect(createCronJob(deps, vaultRoot, ".", "piren", "30m")).rejects.toThrow();
    await expect(createCronJob(deps, vaultRoot, "foo/bar", "piren", "30m")).rejects.toThrow();
  });

  it("writes to agent-scoped directory when agent is provided", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await createCronJob(deps, vaultRoot, "agent-job", "zai", "1d");
    const content = await deps.readFile(join(vaultRoot, "team/zai/cron/jobs/agent-job.md"));
    expect(content).toContain("id: agent-job");
    expect(content).toContain("agent: zai");
  });

  it("reads body from a file when --body is provided", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "templates"));
    await deps.writeFile(
      join(vaultRoot, "templates/my-prompt.md"),
      "# Prompt\n\nCustom body content.",
    );
    await createCronJob(deps, vaultRoot, "body-job", "piren", "6h", join(vaultRoot, "templates/my-prompt.md"));
    const content = await deps.readFile(join(vaultRoot, "team/piren/cron/jobs/body-job.md"));
    expect(content).toContain("Custom body content.");
  });

  it("rejects an invalid agent name", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(createCronJob(deps, vaultRoot, "job", "../other", "30m")).rejects.toThrow(
      /Invalid agent name/,
    );
    await expect(createCronJob(deps, vaultRoot, "job", "..", "30m")).rejects.toThrow(
      /Invalid agent name/,
    );
    await expect(createCronJob(deps, vaultRoot, "job", "foo/bar", "30m")).rejects.toThrow(
      /Invalid agent name/,
    );
  });

  it("rejects a body file that resolves outside the vault", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(
      createCronJob(deps, vaultRoot, "body-job", "piren", "6h", "../secret/file.txt"),
    ).rejects.toThrow(/outside vault/);
  });
});

// ---------------------------------------------------------------------------
// createScriptCronJob
// ---------------------------------------------------------------------------

describe("createScriptCronJob", () => {
  const vaultRoot = "/vault";

  it("writes a script-mode job with the script field", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "scripts"));
    await deps.writeFile(join(vaultRoot, "scripts/backup.sh"), "#!/bin/bash\necho ok");
    await createScriptCronJob(deps, vaultRoot, "backup", "piren", "1d", "scripts/backup.sh");
    const content = await deps.readFile(join(vaultRoot, "team/piren/cron/jobs/backup.md"));
    expect(content).toContain("mode: script");
    expect(content).toContain("script: scripts/backup.sh");
  });

  it("validates the script path is inside the vault", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(
      createScriptCronJob(deps, vaultRoot, "bad", "piren", "1d", "../outside/script.sh"),
    ).rejects.toThrow(/outside vault|resolves outside/);
  });

  it("refuses to overwrite without --force", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "team", "piren", "cron", "jobs"));
    fs.dir(join(vaultRoot, "scripts"));
    await deps.writeFile(join(vaultRoot, "scripts/backup.sh"), "#!/bin/bash\necho ok");
    await deps.writeFile(join(vaultRoot, "team/piren/cron/jobs/backup.md"), "existing");
    await expect(
      createScriptCronJob(deps, vaultRoot, "backup", "piren", "1d", "scripts/backup.sh"),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid agent name", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "scripts"));
    await deps.writeFile(join(vaultRoot, "scripts/backup.sh"), "#!/bin/bash\necho ok");
    await expect(
      createScriptCronJob(deps, vaultRoot, "backup", "../other", "1d", "scripts/backup.sh"),
    ).rejects.toThrow(/Invalid agent name/);
    await expect(
      createScriptCronJob(deps, vaultRoot, "backup", "..", "1d", "scripts/backup.sh"),
    ).rejects.toThrow(/Invalid agent name/);
  });
});

// ---------------------------------------------------------------------------
// enableCronJob / disableCronJob
// ---------------------------------------------------------------------------

describe("enableCronJob and disableCronJob", () => {
  const vaultRoot = "/vault";

  const jobContent = [
    "---",
    "id: toggle-job",
    "agent: piren",
    "schedule: 30m",
    "enabled: false",
    "mode: agent",
    "last_run: null",
    "last_claimed_by: null",
    "---",
    "",
    "# Prompt",
    "",
    "Do something.",
    "",
  ].join("\n");

  it("enableCronJob sets enabled to true", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(join(vaultRoot, "cron/jobs/toggle-job.md"), jobContent);
    await enableCronJob(deps, vaultRoot, "toggle-job");
    const content = await deps.readFile(join(vaultRoot, "cron/jobs/toggle-job.md"));
    expect(content).toContain("enabled: true");
  });

  it("disableCronJob sets enabled to false", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    const enabledContent = jobContent.replace("enabled: false", "enabled: true");
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(join(vaultRoot, "cron/jobs/toggle-job.md"), enabledContent);
    await disableCronJob(deps, vaultRoot, "toggle-job");
    const content = await deps.readFile(join(vaultRoot, "cron/jobs/toggle-job.md"));
    expect(content).toContain("enabled: false");
  });

  it("enable/disable throws on non-existent job", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(enableCronJob(deps, vaultRoot, "ghost")).rejects.toThrow();
    await expect(disableCronJob(deps, vaultRoot, "ghost")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveCronJobPath / readCronJobFile
// ---------------------------------------------------------------------------

describe("resolveCronJobPath and readCronJobFile", () => {
  const vaultRoot = "/vault";

  it("resolves a shared job path from id", async () => {
    const fs = new FakeFs();
    fs.dir(join(vaultRoot, "cron", "jobs"));
    fs.file(join(vaultRoot, "cron/jobs/test-job.md"), "existing");
    const deps = makeDeps(fs);
    const path = await resolveCronJobPath(deps, vaultRoot, "test-job");
    expect(path).toBe(join(vaultRoot, "cron/jobs/test-job.md"));
  });

  it("resolves a relative job path directly", async () => {
    const fs = new FakeFs();
    fs.file(join(vaultRoot, "cron/jobs/test-job.md"), "existing");
    const deps = makeDeps(fs);
    const path = await resolveCronJobPath(deps, vaultRoot, "cron/jobs/test-job.md");
    expect(path).toBe(join(vaultRoot, "cron/jobs/test-job.md"));
  });

  it("resolves an agent-scoped job path", async () => {
    const fs = new FakeFs();
    fs.file(join(vaultRoot, "team/zai/cron/jobs/my-job.md"), "existing");
    const deps = makeDeps(fs);
    const path = await resolveCronJobPath(deps, vaultRoot, "team/zai/cron/jobs/my-job.md");
    expect(path).toBe(join(vaultRoot, "team/zai/cron/jobs/my-job.md"));
  });

  it("throws when job not found", async () => {
    const fs = new FakeFs();
    fs.dir(join(vaultRoot, "cron", "jobs"));
    const deps = makeDeps(fs);
    await expect(resolveCronJobPath(deps, vaultRoot, "ghost")).rejects.toThrow(/not found/);
  });

  it("rejects a path that resolves outside the vault", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    await expect(resolveCronJobPath(deps, vaultRoot, "../../etc/passwd")).rejects.toThrow(
      /outside vault/,
    );
  });

  it("readCronJobFile reads a job file", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(
      join(vaultRoot, "cron/jobs/test-job.md"),
      [
        "---",
        "id: test-job",
        "agent: piren",
        "schedule: 30m",
        "enabled: true",
        "mode: agent",
        "last_run: null",
        "last_claimed_by: null",
        "---",
        "",
        "# Prompt",
        "",
        "Do something.",
        "",
      ].join("\n"),
    );
    const job = await readCronJobFile(deps, vaultRoot, "test-job");
    expect(job.id).toBe("test-job");
    expect(job.agent).toBe("piren");
    expect(job.schedule).toBe("30m");
    expect(job.enabled).toBe(true);
    expect(job.mode).toBe("agent");
    expect(job.prompt).toBe("Do something.");
  });
});

// ---------------------------------------------------------------------------
// validateCronJobs
// ---------------------------------------------------------------------------

describe("validateCronJobs", () => {
  const vaultRoot = "/vault";

  it("returns empty for a vault with no jobs", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    const issues = await validateCronJobs(deps, vaultRoot);
    expect(issues).toEqual([]);
  });

  it("catches an invalid schedule expression", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(
      join(vaultRoot, "cron/jobs/bad-schedule.md"),
      [
        "---",
        "id: bad-schedule",
        "agent: piren",
        "schedule: not-a-schedule",
        "enabled: true",
        "mode: agent",
        "last_run: null",
        "last_claimed_by: null",
        "---",
        "",
        "# Prompt",
        "",
        "Do something.",
        "",
      ].join("\n"),
    );
    const issues = await validateCronJobs(deps, vaultRoot);
    expect(issues.some((i) => i.kind === "invalid-schedule")).toBe(true);
  });

  it("catches a missing agent field for agent-mode jobs", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(
      join(vaultRoot, "cron/jobs/no-agent.md"),
      [
        "---",
        "id: no-agent",
        "agent: ''",
        "schedule: 30m",
        "enabled: true",
        "mode: agent",
        "last_run: null",
        "last_claimed_by: null",
        "---",
        "",
        "# Prompt",
        "",
        "Do something.",
        "",
      ].join("\n"),
    );
    const issues = await validateCronJobs(deps, vaultRoot);
    expect(issues.some((i) => i.kind === "missing-agent")).toBe(true);
  });

  it("catches a missing script field for script-mode jobs", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(
      join(vaultRoot, "cron/jobs/no-script.md"),
      [
        "---",
        "id: no-script",
        "agent: piren",
        "schedule: 30m",
        "enabled: true",
        "mode: script",
        "last_run: null",
        "last_claimed_by: null",
        "---",
        "",
        "# Prompt",
        "",
        "Runs a script.",
        "",
      ].join("\n"),
    );
    const issues = await validateCronJobs(deps, vaultRoot);
    expect(issues.some((i) => i.kind === "missing-script")).toBe(true);
  });

  it("catches a script path that resolves outside the vault", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(
      join(vaultRoot, "cron/jobs/escape-script.md"),
      [
        "---",
        "id: escape-script",
        "agent: piren",
        "schedule: 30m",
        "enabled: true",
        "mode: script",
        "script: ../outside/script.sh",
        "last_run: null",
        "last_claimed_by: null",
        "---",
        "",
        "# Prompt",
        "",
        "Runs outside.",
        "",
      ].join("\n"),
    );
    const issues = await validateCronJobs(deps, vaultRoot);
    expect(issues.some((i) => i.kind === "script-outside-vault")).toBe(true);
  });

  it("reports duplicate job ids as info", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron"));
    fs.dir(join(vaultRoot, "cron", "jobs"));
    fs.dir(join(vaultRoot, "team"));
    fs.dir(join(vaultRoot, "team", "piren"));
    fs.dir(join(vaultRoot, "team", "piren", "cron"));
    fs.dir(join(vaultRoot, "team", "piren", "cron", "jobs"));
    const jobContent = [
      "---",
      "id: dup-id",
      "agent: piren",
      "schedule: 30m",
      "enabled: true",
      "mode: agent",
      "last_run: null",
      "last_claimed_by: null",
      "---",
      "",
      "# Prompt",
      "",
      "Do something.",
      "",
    ].join("\n");
    await deps.writeFile(join(vaultRoot, "cron/jobs/dup-id.md"), jobContent);
    await deps.writeFile(join(vaultRoot, "team/piren/cron/jobs/dup-id.md"), jobContent);
    const issues = await validateCronJobs(deps, vaultRoot);
    const dupIssues = issues.filter((i) => i.kind === "duplicate-id");
    expect(dupIssues.length).toBeGreaterThan(0);
    expect(dupIssues.every((i) => i.severity === "info")).toBe(true);
  });

  it("reports disabled jobs as info", async () => {
    const fs = new FakeFs();
    const deps = makeDeps(fs);
    fs.dir(join(vaultRoot, "cron", "jobs"));
    await deps.writeFile(
      join(vaultRoot, "cron/jobs/disabled.md"),
      [
        "---",
        "id: disabled",
        "agent: piren",
        "schedule: 30m",
        "enabled: false",
        "mode: agent",
        "last_run: null",
        "last_claimed_by: null",
        "---",
        "",
        "# Prompt",
        "",
        "Won't run.",
        "",
      ].join("\n"),
    );
    const issues = await validateCronJobs(deps, vaultRoot);
    expect(issues.some((i) => i.kind === "disabled-job")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatCronList", () => {
  it("renders a message when no jobs exist", () => {
    expect(formatCronList([])).toMatch(/no cron jobs|none/i);
  });

  it("renders job details", () => {
    const jobs = [
      {
        id: "nightly-digest",
        path: "cron/jobs/nightly-digest.md",
        absolutePath: "/v/cron/jobs/nightly-digest.md",
        scope: "shared",
        agent: "piren",
        schedule: { raw: "0 7 * * *", kind: "cron" as const, describe: () => "0 7 * * *" },
        enabled: true,
        mode: "agent" as const,
        prompt: "Do a nightly digest.",
        devicePolicy: { mode: "highest_priority" as const, allowedDevices: [] },
      },
    ];
    const output = formatCronList(jobs);
    expect(output).toContain("nightly-digest");
    expect(output).toContain("0 7 * * *");
    expect(output).toContain("enabled");
  });
});

describe("formatCronShow", () => {
  it("renders the full job document", () => {
    const job: CronJobFile = {
      id: "show-job",
      path: "cron/jobs/show-job.md",
      scope: "shared",
      agent: "piren",
      schedule: "30m",
      enabled: true,
      mode: "agent",
      prompt: "Show this.",
    };
    const output = formatCronShow(job);
    expect(output).toContain("show-job");
    expect(output).toContain("30m");
    expect(output).toContain("Show this.");
  });
});

describe("formatCronRuns", () => {
  it("renders a message when no runs exist", () => {
    expect(formatCronRuns([])).toMatch(/no run records/i);
  });

  it("renders run records", () => {
    const runs = [
      {
        jobId: "test",
        path: "cron/runs/20260101-test.md",
        absolutePath: "/v/cron/runs/20260101-test.md",
        agent: "piren",
        device: "ironman",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
      },
    ];
    const output = formatCronRuns(runs);
    expect(output).toContain("test");
    expect(output).toContain("completed");
    expect(output).toContain("ironman");
  });
});

describe("formatCronValidationReport", () => {
  it("reports OK when no issues", () => {
    expect(formatCronValidationReport([])).toMatch(/OK|no issues/i);
  });

  it("groups issues by severity", () => {
    const issues: CronValidationIssue[] = [
      { kind: "invalid-schedule", severity: "error", message: "Bad schedule: bad-job", jobPath: "cron/jobs/bad-job.md" },
      { kind: "disabled-job", severity: "info", message: "Disabled: off-job", jobPath: "cron/jobs/off-job.md" },
    ];
    const output = formatCronValidationReport(issues);
    expect(output).toContain("Error");
    expect(output).toContain("Note");
  });
});
