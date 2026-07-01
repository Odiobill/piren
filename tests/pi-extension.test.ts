import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../src/pi-extension.js";

let root: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-extension-"));
  const vault = join(root, "vault");
  agentDir = join(vault, "team", "thor");
  await mkdir(join(agentDir, "logs"), { recursive: true });
  await mkdir(join(agentDir, "inbox"), { recursive: true });
  await mkdir(join(agentDir, "outbox"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  await writeFile(join(vault, "steward-directives.md"), "# Steward\n");
  await writeFile(join(agentDir, "SOUL.md"), "# Thor\n");
  await writeFile(join(agentDir, "MEMORY.md"), "# Memory\n");
  await writeFile(join(agentDir, "config.yml"), "model: {}\n");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function fakePi() {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const events: Record<string, Function[]> = {};
  return {
    tools,
    commands,
    events,
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand(name: string, command: any) {
      commands[name] = command;
    },
    on(event: string, handler: Function) {
      events[event] ??= [];
      events[event].push(handler);
    },
  };
}

describe("Pi extension", () => {
  it("registers the selected device, vault tools, send_to_agent, session summaries, and piren_status", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" },
      configPath: join(root, "missing-config.yml"),
    });

    const deviceRecord = JSON.parse(await readFile(join(root, "vault", "team", "thor", "devices", "heimdall.json"), "utf8"));
    expect(deviceRecord.device_id).toBe("heimdall");
    expect(deviceRecord.hostname).toBe("heimdall.local");
    expect(deviceRecord.status).toBe("active");
    expect(deviceRecord.last_seen).toBeTruthy();

    expect(Object.keys(pi.tools).sort()).toEqual(["cron_claim", "cron_list", "cron_record_run", "cron_runs", "decision_record", "flag_steward", "inbox_list", "project_append_log", "project_status", "project_update_handoff", "runbook_write", "self_improvement_trigger_check", "send_to_agent", "session_write_summary", "skill_candidate_write", "skill_list", "skill_read", "task_claim", "task_update_status", "vault_append_log", "vault_conformance_check", "vault_list", "vault_patch", "vault_read", "vault_read_cached", "vault_write", "wiki_update_concept", "wiki_update_entity"]);
    expect(pi.commands.piren_status).toBeDefined();

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.commands.piren_status.handler([], {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe("info");
    expect(notifications[0]?.message).toContain("Piren status");
    expect(notifications[0]?.message).toContain("registered_tools: cron_claim, cron_list, cron_record_run, cron_runs, decision_record, flag_steward, inbox_list, project_append_log, project_status, project_update_handoff, runbook_write, self_improvement_trigger_check, send_to_agent, session_write_summary, skill_candidate_write, skill_list, skill_read, task_claim, task_update_status, vault_append_log, vault_conformance_check, vault_list, vault_patch, vault_read, vault_read_cached, vault_write, wiki_update_concept, wiki_update_entity");
    expect(notifications[0]?.message).toContain("write_mode: authoritative-vault");

    const alert = await pi.tools.flag_steward.execute("call-alert", {
      title: "Vault unavailable",
      body: "Thor cannot reach the NAS vault.",
      severity: "high",
      notify: true,
    });
    expect(alert.content[0].text).toContain("Created steward alert steward-inbox/alerts/");
    expect(alert.details.from).toBe("thor");
    expect(alert.details.severity).toBe("high");
    expect(alert.details.status).toBe("open");
    const alertContent = await readFile(join(root, "vault", alert.details.path), "utf8");
    expect(alertContent).toContain("# Vault unavailable");
    expect(alertContent).toContain("severity: high");

    const read = await pi.tools.vault_read.execute("call-1", { path: "steward-directives.md" });
    expect(read.content[0].text).toContain("# Steward");
    expect(read.details.path).toBe("steward-directives.md");

    const list = await pi.tools.vault_list.execute("call-list", { path: "team/thor" });
    expect(list.content[0].text).toContain("logs");
    expect(list.details.entries.map((entry: any) => entry.path)).toContain("team/thor/logs");

    const patch = await pi.tools.vault_patch.execute("call-patch", {
      path: "steward-directives.md",
      old_text: "# Steward",
      new_text: "# Updated Steward",
    });
    expect(patch.content[0].text).toContain("Patched steward-directives.md");
    expect(patch.details.replacements).toBe(1);

    const append = await pi.tools.vault_append_log.execute("call-append", {
      path: "team/thor/logs/activity.md",
      entry: "Did work",
    });
    expect(append.content[0].text).toContain("Appended log entry to team/thor/logs/activity.md");
    expect(append.details.bytesAppended).toBeGreaterThan(0);

    const summary = await pi.tools.session_write_summary.execute("call-summary", {
      title: "Test Session",
      summary: "Implemented a fake Pi test.",
    });
    expect(summary.content[0].text).toContain("Wrote session summary");
    expect(summary.details.path).toMatch(/^team\/thor\/sessions\/.*test-session\.md$/);

    const sent = await pi.tools.send_to_agent.execute("call-send", {
      to: "thor",
      title: "Check disk usage",
      body: "Please check disk usage on the NAS.",
    });
    expect(sent.content[0].text).toContain("Created task team/thor/inbox/");
    expect(sent.details.status).toBe("pending");
    expect(sent.details.from).toBe("thor");
    expect(sent.details.to).toBe("thor");
    const taskContent = await readFile(join(root, "vault", sent.details.path), "utf8");
    expect(taskContent).toContain("# Check disk usage");
    expect(taskContent).toContain("status: pending");

    const updatedTask = await pi.tools.task_update_status.execute("call-update-task", {
      task_path: sent.details.path,
      status: "completed",
      result: "Disk usage is below threshold.",
    });
    expect(updatedTask.content[0].text).toContain(`Updated task ${sent.details.path} to completed`);
    expect(updatedTask.details.status).toBe("completed");
    const updatedTaskContent = await readFile(join(root, "vault", sent.details.path), "utf8");
    expect(updatedTaskContent).toContain("status: completed");
    expect(updatedTaskContent).toContain("## Result\n\nDisk usage is below threshold.");

    const inbox = await pi.tools.inbox_list.execute("call-inbox-list", {});
    expect(inbox.content[0].text).toContain("completed\tCheck disk usage");
    expect(inbox.details.agentName).toBe("thor");
    expect(inbox.details.tasks).toHaveLength(1);
    expect(inbox.details.tasks[0].path).toBe(sent.details.path);

    const claimed = await pi.tools.task_claim.execute("call-task-claim", {
      task_path: sent.details.path,
      device_id: "heimdall",
    });
    expect(claimed.content[0].text).toContain("Claimed task team/thor/inbox/");
    expect(claimed.content[0].text).toContain(".claimed.heimdall.md");
    expect(claimed.details.originalPath).toBe(sent.details.path);
    expect(claimed.details.path).toContain(".claimed.heimdall.md");
    await expect(readFile(join(root, "vault", sent.details.path), "utf8")).rejects.toThrow();
    const afterClaimInbox = await pi.tools.inbox_list.execute("call-inbox-list-after-claim", {});
    expect(afterClaimInbox.content[0].text).toBe("No inbox tasks.");
    expect(afterClaimInbox.details.tasks).toHaveLength(0);

    const blocked = await pi.tools.vault_write.execute("call-2", { path: "../outside.md", content: "bad" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/outside vault/i);
  });

  it("registers and exercises project_status, project_append_log, and decision_record", async () => {
    const vault = join(root, "vault");
    await mkdir(join(vault, "Projects", "Piren", "decisions"), { recursive: true });
    await writeFile(
      join(vault, "Projects", "Piren", "index.md"),
      [
        "---",
        'title: "Piren Project Index"',
        "created: 2026-06-21",
        "updated: 2026-06-25",
        "status: phase-4-knowledge",
        "---",
        "",
        "# Piren Project Index",
      ].join("\n"),
    );

    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const status = await pi.tools.project_status.execute("call-status", { project: "Piren" });
    expect(status.isError).toBeUndefined();
    expect(status.content[0].text).toContain("phase-4-knowledge");
    expect(status.details.available).toBe(true);
    expect(status.details.title).toBe("Piren Project Index");

    const log = await pi.tools.project_append_log.execute("call-log", {
      project: "Piren",
      entry: "Added knowledge lifecycle tools.",
    });
    expect(log.isError).toBeUndefined();
    expect(log.content[0].text).toContain("Appended project log entry to Projects/Piren/log.md");
    expect(log.details.bytesAppended).toBeGreaterThan(0);
    const logContent = await readFile(join(vault, "Projects", "Piren", "log.md"), "utf8");
    expect(logContent).toContain("Added knowledge lifecycle tools.");
    expect(logContent).toContain("agent: thor");

    const adr = await pi.tools.decision_record.execute("call-adr", {
      project: "Piren",
      id: "0015",
      title: "Knowledge Lifecycle Tools",
      context: "Agents need explicit tools to leave durable artifacts.",
      decision: "Add project_status, project_append_log, and decision_record.",
      consequences: "Agents can promote task lessons into project logs and ADRs.",
    });
    expect(adr.isError).toBeUndefined();
    expect(adr.content[0].text).toContain("Wrote ADR Projects/Piren/decisions/ADR-0015-knowledge-lifecycle-tools.md");
    const adrContent = await readFile(join(vault, "Projects", "Piren", "decisions", "ADR-0015-knowledge-lifecycle-tools.md"), "utf8");
    expect(adrContent).toContain("# ADR-0015 - Knowledge Lifecycle Tools");
    expect(adrContent).toContain("## Context");
    expect(adrContent).toContain("## Decision");
    expect(adrContent).toContain("## Consequences");

    const handoff = await pi.tools.project_update_handoff.execute("call-handoff", {
      project: "Piren",
      content: "# Handoff\n\nContinue with cron.\n",
    });
    expect(handoff.isError).toBeUndefined();
    expect(handoff.content[0].text).toContain("Updated project handoff Projects/Piren/handoff-prompt.md");
    const handoffContent = await readFile(join(vault, "Projects", "Piren", "handoff-prompt.md"), "utf8");
    expect(handoffContent).toContain("Continue with cron.");

    const runbook = await pi.tools.runbook_write.execute("call-runbook", {
      project: "Piren",
      title: "Gateway Recovery",
      content: "Restart the gateway and inspect logs.",
    });
    expect(runbook.isError).toBeUndefined();
    expect(runbook.content[0].text).toContain("Wrote runbook Projects/Piren/runbooks/gateway-recovery.md");
    const runbookContent = await readFile(join(vault, "Projects", "Piren", "runbooks", "gateway-recovery.md"), "utf8");
    expect(runbookContent).toContain("# Gateway Recovery");
    expect(runbookContent).toContain("Restart the gateway");

    const candidate = await pi.tools.skill_candidate_write.execute("call-skill-candidate", {
      name: "release-checklist",
      description: "Verify a Piren release candidate.",
      body: "Run tests, typecheck, build, and smoke.",
      scope: "Piren",
    });
    expect(candidate.isError).toBeUndefined();
    expect(candidate.content[0].text).toContain("Wrote skill candidate Projects/Piren/skill-candidates/release-checklist.md");
    const candidateContent = await readFile(join(vault, "Projects", "Piren", "skill-candidates", "release-checklist.md"), "utf8");
    expect(candidateContent).toContain("status: candidate");
    expect(candidateContent).toContain("Run tests, typecheck, build, and smoke.");

    const missing = await pi.tools.project_status.execute("call-missing", { project: "NoSuchProject" });
    expect(missing.isError).toBeUndefined();
    expect(missing.details.available).toBe(false);
  });

  it("registers and exercises OKF wiki concept and entity tools", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const concept = await pi.tools.wiki_update_concept.execute("call-wiki-concept", {
      title: "Vault as Memory",
      description: "Visible vault artifacts replace hidden memory stores.",
      tags: ["piren", "memory"],
      content: "Piren's memory is the vault, represented as OKF documents.",
      links: ["/Projects/Piren/knowledge-lifecycle.md"],
    });
    expect(concept.isError).toBeUndefined();
    expect(concept.content[0].text).toContain("Wrote wiki concept wiki/concepts/vault-as-memory.md");
    const conceptContent = await readFile(join(root, "vault", "wiki", "concepts", "vault-as-memory.md"), "utf8");
    expect(conceptContent).toContain("type: Concept");
    expect(conceptContent).toContain('title: "Vault as Memory"');
    expect(conceptContent).toContain("- /Projects/Piren/knowledge-lifecycle.md");

    const entity = await pi.tools.wiki_update_entity.execute("call-wiki-entity", {
      title: "Pi Coding Agent",
      content: "Piren runs as a Pi extension.",
      links: ["/Projects/Piren/decisions/ADR-0001-build-on-pi.md"],
    });
    expect(entity.isError).toBeUndefined();
    expect(entity.content[0].text).toContain("Wrote wiki entity wiki/entities/pi-coding-agent.md");
    const entityContent = await readFile(join(root, "vault", "wiki", "entities", "pi-coding-agent.md"), "utf8");
    expect(entityContent).toContain("type: Entity");
    expect(entityContent).toContain("Piren runs as a Pi extension.");

    const bad = await pi.tools.wiki_update_concept.execute("call-wiki-bad", {
      title: "Bad",
      content: "Bad link.",
      links: ["../outside.md"],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/invalid wiki link/i);
  });

  it("allows task_claim to reclaim stale claims using device heartbeat timestamps", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_DEVICE_ID: "thor-laptop", PIREN_HOSTNAME: "thor.local" },
      configPath: join(root, "missing-config.yml"),
    });
    await writeFile(join(root, "vault", "team", "thor", "devices", "heimdall.json"), JSON.stringify({
      device_id: "heimdall",
      hostname: "heimdall.local",
      priority: 10,
      status: "active",
      started_at: "2026-06-22T16:00:00.000Z",
      last_seen: "2026-06-22T16:00:00.000Z",
    }, null, 2) + "\n");
    const sent = await pi.tools.send_to_agent.execute("call-send-stale", {
      to: "thor",
      title: "Recover stale claim",
      body: "Reclaim this after heimdall goes stale.",
    });
    const stale = await pi.tools.task_claim.execute("call-claim-stale", {
      task_path: sent.details.path,
      device_id: "heimdall",
    });

    const reclaimed = await pi.tools.task_claim.execute("call-reclaim-stale", {
      task_path: stale.details.path,
      device_id: "thor-laptop",
      stale_after_ms: 5 * 60 * 1000,
      now: "2026-06-22T16:10:01.000Z",
    });

    expect(reclaimed.isError).toBeUndefined();
    expect(reclaimed.content[0].text).toContain("Claimed task");
    expect(reclaimed.details.originalPath).toBe(stale.details.path);
    expect(reclaimed.details.path).toContain(".claimed.thor-laptop.md");
    await expect(readFile(join(root, "vault", stale.details.path), "utf8")).rejects.toThrow();
    const reclaimedContent = await readFile(join(root, "vault", reclaimed.details.path), "utf8");
    expect(reclaimedContent).toContain("# Recover stale claim");
  });

  it("polls the selected allowed agent inbox on session start only in opt-in worker mode", async () => {
    const pi = fakePi();
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + join(root, "vault") + "\n" + "allowed_agents:\n" + "  - thor\n");
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_WORKER: "1", PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" },
      configPath,
    });
    const sent = await pi.tools.send_to_agent.execute("call-send-worker", {
      to: "thor",
      title: "Worker task",
      body: "Worker mode should announce this task.",
    });
    expect(sent.isError).toBeUndefined();

    const notifications: Array<{ message: string; level: string }> = [];
    const sessionStart = pi.events.session_start?.[0];
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(notifications.map((entry) => entry.message)).toContain("Piren loaded: thor at " + agentDir + "; vault_root=" + join(root, "vault") + "; device=heimdall");
    expect(notifications.some((entry) => entry.message.includes("Worker inbox poll: 1 task(s) available") && entry.message.includes("Worker task"))).toBe(true);
  });

  it("registers vault_write with local outbox queuing when the vault disappears after startup", async () => {
    const pi = fakePi();
    const localOutbox = join(root, "local-outbox");
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_LOCAL_OUTBOX_DIR: localOutbox },
      configPath: join(root, "missing-config.yml"),
    });
    await rm(join(root, "vault"), { recursive: true, force: true });

    const queued = await pi.tools.vault_write.execute("call-offline", {
      path: "team/thor/logs/offline.md",
      content: "queued by extension\n",
    });

    expect(queued.isError).toBeUndefined();
    expect(queued.content[0].text).toContain("Queued blocked vault write to local outbox");
    expect(queued.details.queued).toBe(true);
    expect(queued.details.authoritative).toBe(false);
    const proposal = await readFile(queued.details.outboxPath, "utf8");
    expect(proposal).toContain("original_path: team/thor/logs/offline.md");
    expect(proposal).toContain("queued by extension");
  });

  it("registers explicit vault_read_cached that reads non-authoritative local cache when the vault is unavailable", async () => {
    const pi = fakePi();
    const localCache = join(root, "local-cache");
    await mkdir(join(localCache, "team", "thor", "logs"), { recursive: true });
    await writeFile(join(localCache, "team", "thor", "logs", "cached.md"), "cached copy\n");
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_LOCAL_CACHE_DIR: localCache },
      configPath: join(root, "missing-config.yml"),
    });
    await rm(join(root, "vault"), { recursive: true, force: true });

    const cached = await pi.tools.vault_read_cached.execute("call-cache", {
      path: "team/thor/logs/cached.md",
    });

    expect(cached.isError).toBeUndefined();
    expect(cached.content[0].text).toBe("cached copy\n");
    expect(cached.details.path).toBe("team/thor/logs/cached.md");
    expect(cached.details.cached).toBe(true);
    expect(cached.details.authoritative).toBe(false);
  });

  it("injects a context prompt that tells the agent not to auto-check the inbox in direct conversations", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const beforeStart = pi.events.before_agent_start?.[0];
    expect(beforeStart).toBeDefined();
    const result = await beforeStart?.();
    expect(result).toBeDefined();
    const content = (result as { message: { content: string } }).message.content;
    // The context prompt must tell the agent not to auto-check the inbox
    // in direct (non-worker) conversations. The steward must ask explicitly.
    expect(content).toMatch(/do not.*check.*inbox/i);
    // The context prompt lists the knowledge lifecycle tools and guidance.
    expect(content).toContain("project_status(project)");
    expect(content).toContain("project_append_log(project, entry)");
    expect(content).toContain("decision_record(project, id, title, context, decision, consequences?, alternatives?)");
    expect(content).toContain("Knowledge Lifecycle");
    expect(content).toMatch(/only.*steward.*asks|only.*worker.*mode/i);
  });

  it("injects a lazy vault skill catalog into the context prompt when skills exist", async () => {
    const pi = fakePi();
    const vault = join(root, "vault");
    await mkdir(join(vault, "skills"), { recursive: true });
    await writeFile(
      join(vault, "skills", "check-disk.md"),
      [
        "---",
        "name: check-disk",
        'description: "Check disk usage and report high partitions."',
        "---",
        "",
        "# Check Disk",
        "",
        "1. Run df -h",
      ].join("\n"),
    );
    await mkdir(join(vault, "team", "thor", "skills"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "skills", "deploy.md"),
      [
        "---",
        "name: deploy",
        'description: "Deploy the app to staging."',
        "---",
        "",
        "# Deploy",
      ].join("\n"),
    );
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const beforeStart = pi.events.before_agent_start?.[0];
    expect(beforeStart).toBeDefined();
    const result = await beforeStart?.();
    expect(result).toBeDefined();
    const content = (result as { message: { content: string } }).message.content;
    // Both shared and agent-specific skills appear in the context prompt as a catalog only.
    expect(content).toContain("Available Skills");
    expect(content).toContain("check-disk");
    expect(content).toContain("Check disk usage and report high partitions.");
    expect(content).toContain("Path: skills/check-disk.md");
    expect(content).toContain("deploy");
    expect(content).toContain("Deploy the app to staging.");
    expect(content).toContain("Path: team/thor/skills/deploy.md");
    expect(content).toContain("skill_read(name)");
    expect(content).not.toContain("# Check Disk");
    expect(content).not.toContain("Run df -h");
    expect(content).not.toContain("# Deploy");
  });

  it("omits the skills section when no skills exist", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const beforeStart = pi.events.before_agent_start?.[0];
    expect(beforeStart).toBeDefined();
    const result = await beforeStart?.();
    expect(result).toBeDefined();
    const content = (result as { message: { content: string } }).message.content;
    // No skills section when the vault has none.
    expect(content).not.toContain("Available Skills");
  });

  it("reports skill count in piren_status when skills are loaded", async () => {
    const pi = fakePi();
    const vault = join(root, "vault");
    await mkdir(join(vault, "skills"), { recursive: true });
    await writeFile(
      join(vault, "skills", "check-disk.md"),
      [
        "---",
        "name: check-disk",
        'description: "Check disk usage."',
        "---",
        "",
        "# Check Disk",
      ].join("\n"),
    );
    await mkdir(join(vault, "team", "thor", "skills"), { recursive: true });
    await writeFile(
      join(vault, "team", "thor", "skills", "deploy.md"),
      [
        "---",
        "name: deploy",
        'description: "Deploy the app."',
        "---",
        "",
        "# Deploy",
      ].join("\n"),
    );
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.commands.piren_status.handler([], {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });
    expect(notifications).toHaveLength(1);
    // The status report includes the skill count (2: check-disk + deploy).
    expect(notifications[0]?.message).toContain("skills_loaded: 2");
  });

  it("reports skills_loaded: 0 in piren_status when no skills exist", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.commands.piren_status.handler([], {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });
    expect(notifications[0]?.message).toContain("skills_loaded: 0");
  });

  it("reports declared packages in piren_status", async () => {
    const pi = fakePi();
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + join(root, "vault") + "\n" + "allowed_agents:\n" + "  - thor\n" + "packages:\n" + '  - "@piren/web-search"\n' + '  - "@piren/git-tools"\n');
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath,
    });

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.commands.piren_status.handler([], {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("packages: @piren/web-search, @piren/git-tools");
  });

  it("registers skill_list and skill_read for lazy skill loading", async () => {
    const pi = fakePi();
    const vault = join(root, "vault");
    await mkdir(join(vault, "skills"), { recursive: true });
    await writeFile(
      join(vault, "skills", "check-disk.md"),
      [
        "---",
        "name: check-disk",
        'description: "Check disk usage and report high partitions."',
        "---",
        "",
        "# Check Disk",
        "",
        "1. Run df -h",
      ].join("\n"),
    );
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    expect(pi.tools.skill_list).toBeDefined();
    expect(pi.tools.skill_read).toBeDefined();

    const list = await pi.tools.skill_list.execute("call-skill-list", {});
    expect(list.isError).toBeUndefined();
    expect(list.content[0].text).toContain("check-disk");
    expect(list.details.skills).toEqual([
      {
        name: "check-disk",
        description: "Check disk usage and report high partitions.",
        source: "shared",
        path: "skills/check-disk.md",
      },
    ]);

    const read = await pi.tools.skill_read.execute("call-skill-read", { name: "check-disk" });
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toContain("# Check Disk");
    expect(read.content[0].text).toContain("Run df -h");
    expect(read.details.name).toBe("check-disk");

    const missing = await pi.tools.skill_read.execute("call-skill-missing", { name: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Unknown skill: missing");
  });

  it("reports packages: <none> in piren_status when no packages are declared", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.commands.piren_status.handler([], {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });
    expect(notifications[0]?.message).toContain("packages: <none>");
  });
});

describe("Pi extension cron tools (ADR-0019)", () => {
  async function loadCronExtension(env: Record<string, string | undefined> = { PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" }) {
    const pi = fakePi();
    await extension(pi as any, { cliAgentDir: agentDir, env, configPath: join(root, "missing-config.yml") });
    return pi;
  }

  async function writeSharedJob(name: string, schedule: string, agent: string): Promise<void> {
    await mkdir(join(root, "vault", "cron", "jobs"), { recursive: true });
    await writeFile(
      join(root, "vault", "cron", "jobs", `${name}.md`),
      ["---", `id: ${name}`, `agent: "${agent}"`, `schedule: "${schedule}"`, "enabled: true", "---", "", "# Prompt", "", `Do ${name}.`, ""].join("\n"),
    );
  }

  it("lists, claims, records a run for, and shows history for a cron job", async () => {
    await writeSharedJob("nightly-digest", "0 7 * * *", "thor");
    const pi = await loadCronExtension();

    const list = await pi.tools.cron_list.execute("cron-list", {});
    expect(list.isError).toBeUndefined();
    expect(list.content[0].text).toContain("nightly-digest");
    expect(list.details.jobs[0].id).toBe("nightly-digest");
    expect(list.details.jobs[0].scope).toBe("shared");

    const claim = await pi.tools.cron_claim.execute("cron-claim", { job_path: "cron/jobs/nightly-digest.md", device_id: "heimdall" });
    expect(claim.isError).toBeUndefined();
    expect(claim.details.path).toBe("cron/jobs/nightly-digest.claimed.heimdall.md");

    const record = await pi.tools.cron_record_run.execute("cron-record", {
      job_path: claim.details.path,
      status: "completed",
      result: "Digest produced, no urgent items.",
      started_at: "2026-06-25T07:00:05.000Z",
      finished_at: "2026-06-25T07:00:42.000Z",
    });
    expect(record.isError).toBeUndefined();
    expect(record.details.runPath).toBe("cron/runs/20260625T070005000Z-nightly-digest.md");
    expect(record.details.restoredJobPath).toBe("cron/jobs/nightly-digest.md");

    const runRecord = await readFile(join(root, "vault", record.details.runPath), "utf8");
    expect(runRecord).toContain("status: completed");
    expect(runRecord).toContain("device: heimdall");

    const restored = await readFile(join(root, "vault", "cron", "jobs", "nightly-digest.md"), "utf8");
    expect(restored).toContain("last_run: 2026-06-25T07:00:42.000Z");

    const runs = await pi.tools.cron_runs.execute("cron-runs", {});
    expect(runs.isError).toBeUndefined();
    expect(runs.details.runs[0].jobId).toBe("nightly-digest");
    expect(runs.details.runs[0].status).toBe("completed");

    const filtered = await pi.tools.cron_runs.execute("cron-runs-filtered", { job_id: "nightly-digest" });
    expect(filtered.details.runs).toHaveLength(1);
  });

  it("surfaces due cron jobs owned by this device in worker mode without auto-running them", async () => {
    await writeSharedJob("check-github", "15m", "thor");
    const configPath = join(root, "worker-config.yml");
    await writeFile(configPath, "vault_root: " + join(root, "vault") + "\n" + "allowed_agents:\n" + "  - thor\n");
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_WORKER: "1", PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" },
      configPath,
    });

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.events.session_start?.[0]?.({}, {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    // The worker surfaces the due job but does NOT claim or run it: no run
    // record file should exist, and the job file should still be unclaimed.
    expect(notifications.some((n) => n.message.includes("Worker cron: 1 due job(s) owned by this device") && n.message.includes("check-github"))).toBe(true);
    expect(notifications.some((n) => n.message.includes("Use cron_claim then cron_record_run"))).toBe(true);
    await expect(readFile(join(root, "vault", "cron", "runs"), "utf8")).rejects.toThrow();
    await expect(readFile(join(root, "vault", "cron", "jobs", "check-github.md"), "utf8")).resolves.toBeDefined();
  });

  it("executes due script-mode cron jobs directly in worker mode and records the run", async () => {
    await mkdir(join(root, "vault", "scripts"), { recursive: true });
    const scriptPath = join(root, "vault", "scripts", "disk-check.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho script-worker:$PIREN_AGENT:$PIREN_VAULT_ROOT\n", "utf8");
    await chmod(scriptPath, 0o755);
    await mkdir(join(root, "vault", "cron", "jobs"), { recursive: true });
    await writeFile(
      join(root, "vault", "cron", "jobs", "disk-check.md"),
      [
        "---",
        "id: disk-check",
        'agent: "thor"',
        'schedule: "15m"',
        "mode: script",
        "script: scripts/disk-check.sh",
        "enabled: true",
        "---",
        "",
        "# Disk check",
        "",
      ].join("\n"),
    );
    const configPath = join(root, "worker-config.yml");
    await writeFile(configPath, "vault_root: " + join(root, "vault") + "\n" + "allowed_agents:\n" + "  - thor\n");
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_WORKER: "1", PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" },
      configPath,
    });

    const notifications: Array<{ message: string; level: string }> = [];
    await pi.events.session_start?.[0]?.({}, {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(notifications.some((n) => n.message.includes("Worker cron script: completed disk-check"))).toBe(true);
    const runDir = join(root, "vault", "cron", "runs");
    const runs = await readdir(runDir);
    expect(runs).toHaveLength(1);
    const content = await readFile(join(runDir, runs[0] ?? ""), "utf8");
    expect(content).toContain("mode: script");
    expect(content).toContain("script-worker:thor:" + join(root, "vault"));
    await expect(readFile(join(root, "vault", "cron", "jobs", "disk-check.md"), "utf8")).resolves.toContain("last_run:");
  });

  it("includes the vault-backed cron tools and guidance in the context prompt", async () => {
    const pi = await loadCronExtension();
    const beforeStart = pi.events.before_agent_start?.[0];
    expect(beforeStart).toBeDefined();
    const result = await beforeStart?.();
    const content = (result as { message: { content: string } }).message.content;
    expect(content).toContain("cron_list()");
    expect(content).toContain("cron_claim(job_path, stale_after_ms?)");
    expect(content).toContain("cron_record_run(job_path, status, result, started_at, finished_at)");
    expect(content).toContain("cron_runs(job_id?)");
    expect(content).toContain("Vault-Backed Cron (ADR-0019 + ADR-0023)");
    expect(content).toContain("Script-mode jobs");
  });
});

describe("Pi extension OKF conformance tool (ADR-0022)", () => {
  async function loadOkfExtension() {
    const pi = fakePi();
    await extension(pi as any, { cliAgentDir: agentDir, env: { PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" }, configPath: join(root, "missing-config.yml") });
    return pi;
  }

  it("reports a conformant vault", async () => {
    await mkdir(join(root, "vault", "wiki", "concepts"), { recursive: true });
    await writeFile(join(root, "vault", "wiki", "concepts", "ok.md"), "---\ntype: Concept\ntitle: Ok\n---\n\n# Ok\n");
    const pi = await loadOkfExtension();

    const result = await pi.tools.vault_conformance_check.execute("okf", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("conformant");
    expect(result.details.ok).toBe(true);
    expect(result.details.checked).toBe(1);
  });

  it("reports problems for a non-conformant vault", async () => {
    await mkdir(join(root, "vault", "wiki", "concepts"), { recursive: true });
    await writeFile(join(root, "vault", "wiki", "concepts", "no-type.md"), "---\ntitle: No Type\n---\n\n# No Type\n");
    const pi = await loadOkfExtension();

    const result = await pi.tools.vault_conformance_check.execute("okf", {});
    expect(result.isError).toBeUndefined();
    expect(result.details.ok).toBe(false);
    expect(result.details.problems[0].kind).toBe("missing-type");
    expect(result.details.problems[0].path).toContain("no-type.md");
  });

  it("includes the OKF tool and guidance in the context prompt", async () => {
    const pi = await loadOkfExtension();
    const beforeStart = pi.events.before_agent_start?.[0];
    expect(beforeStart).toBeDefined();
    const out = await beforeStart?.();
    const content = (out as { message: { content: string } }).message.content;
    expect(content).toContain("vault_conformance_check()");
    expect(content).toContain("Open Knowledge Format");
    expect(content).toContain("wiki_update_concept(title, content, description?, tags?, links?)");
    expect(content).toContain("wiki_update_entity(title, content, description?, tags?, links?)");
    expect(content).toContain("Inspectable Self-Improvement Triggers");
    expect(content).toContain("self_improvement_trigger_check(message)");
  });

  it("registers a read-only self-improvement trigger check tool", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const result = await pi.tools.self_improvement_trigger_check.execute("call-trigger", {
      message: "Actually, use wiki_update_concept for tool quirks.",
    });

    expect(result.isError).toBeUndefined();
    expect(result.details.trigger.triggered).toBe(true);
    expect(result.content[0].text).toContain("Correction detected");
    expect(result.content[0].text).toContain("wiki_update_concept");
  });

  it("does not register an auto-nudge message_end handler when auto-nudge is disabled (default)", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });
    expect(pi.events.message_end ?? []).toHaveLength(0);
  });

  it("registers a message_end handler that nudges on a correction when PIREN_AUTO_NUDGE=1", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_AUTO_NUDGE: "1" },
      configPath: join(root, "missing-config.yml"),
    });

    const handler = pi.events.message_end?.[0];
    expect(handler).toBeDefined();

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };

    await handler?.(
      { message: { role: "user", content: "Please don't use a hidden memory store." } },
      ctx,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe("info");
    expect(notifications[0]?.message).toContain("ADR-0024");
    expect(notifications[0]?.message).toContain("Correction detected");
    expect(notifications[0]?.message).toContain("skill_candidate_write");
  });

  it("registers a message_end handler when team config opts in via self_improvement.auto_nudge", async () => {
    await writeFile(
      join(agentDir, "config.yml"),
      "model: {}\nself_improvement:\n  auto_nudge: true\n",
    );
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });

    const handler = pi.events.message_end?.[0];
    expect(handler).toBeDefined();

    const notifications: Array<{ message: string; level: string }> = [];
    await handler?.(
      { message: { role: "user", content: [{ type: "text", text: "Actually, use wiki_update_concept for tool quirks." }] } },
      { ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("wiki_update_concept");
  });

  it("auto-nudge handler ignores assistant messages, non-corrections, and unknown shapes without throwing", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_AUTO_NUDGE: "1" },
      configPath: join(root, "missing-config.yml"),
    });

    const handler = pi.events.message_end?.[0];
    expect(handler).toBeDefined();
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = { ui: { notify: (m: string, l: string) => notifications.push({ message: m, level: l }) } };

    await handler?.({ message: { role: "assistant", content: "No, that is wrong." } }, ctx);
    await handler?.({ message: { role: "user", content: "Looks great, thanks!" } }, ctx);
    await handler?.({ message: { role: "user", content: "No worries, this is fine." } }, ctx);
    await handler?.({}, ctx);
    await handler?.({ message: null }, ctx);

    expect(notifications).toHaveLength(0);
  });

  it("auto-nudge handler swallows internal errors so it never aborts a turn", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_AUTO_NUDGE: "1" },
      configPath: join(root, "missing-config.yml"),
    });
    const handler = pi.events.message_end?.[0];
    expect(handler).toBeDefined();
    const ctx = {
      ui: {
        notify() {
          throw new Error("ui.notify exploded");
        },
      },
    };
    await expect(
      handler?.({ message: { role: "user", content: "Please don't use a hidden memory store." } }, ctx),
    ).resolves.not.toThrow();
  });

  it("runs the opt-in ADR-0024 review loop through a child Pi prompt after the configured turn interval", async () => {
    const pi = fakePi() as ReturnType<typeof fakePi> & { exec: any };
    const execCalls: Array<{ command: string; args: string[]; options: { timeout?: number } }> = [];
    pi.exec = async (command: string, args: string[], options: { timeout?: number }) => {
      execCalls.push({ command, args, options });
      return { code: 0, stdout: "Nothing to promote." };
    };

    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_REVIEW_LOOP: "1", PIREN_REVIEW_INTERVAL_TURNS: "2", PIREN_REVIEW_RECENT_MESSAGES: "3" },
      configPath: join(root, "missing-config.yml"),
    });

    const handler = pi.events.turn_end?.[0];
    expect(handler).toBeDefined();
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { message: { role: "user", content: "Actually, write that down." } },
          { message: { role: "assistant", content: "I will use a visible artifact." } },
        ],
      },
      ui: { notify: () => undefined },
    };

    await handler?.({ message: { role: "assistant", content: "first" } }, ctx);
    expect(execCalls).toHaveLength(0);
    await handler?.({ message: { role: "assistant", content: "second" } }, ctx);
    await Promise.resolve();

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.command).toBe("pi");
    expect(execCalls[0]?.options.timeout).toBe(120000);
    expect(execCalls[0]?.args).toEqual(expect.arrayContaining(["-p", "--no-session", "--no-extensions", "--vault-root", join(root, "vault"), "--agent", "thor"]));
    const prompt = execCalls[0]?.args.at(-1) ?? "";
    expect(prompt).toContain("ADR-0024 inspectable self-improvement review");
    expect(prompt).toContain("user: Actually, write that down.");
    expect(prompt).toContain("Nothing to promote");
  });

  it("passes large raw vault artifacts into the ADR-0024 review prompt as promotion candidates", async () => {
    await mkdir(join(root, "vault", "Projects", "Piren"), { recursive: true });
    await writeFile(join(root, "vault", "Projects", "Piren", "log.md"), "x".repeat(60_000));
    const pi = fakePi() as ReturnType<typeof fakePi> & { exec: any };
    const execCalls: Array<{ command: string; args: string[]; options: { timeout?: number } }> = [];
    pi.exec = async (command: string, args: string[], options: { timeout?: number }) => {
      execCalls.push({ command, args, options });
      return { code: 0, stdout: "Nothing to promote." };
    };

    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: { PIREN_REVIEW_LOOP: "1", PIREN_REVIEW_INTERVAL_TURNS: "1" },
      configPath: join(root, "missing-config.yml"),
    });

    const handler = pi.events.turn_end?.[0];
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { message: { role: "user", content: "Continue Piren." } },
          { message: { role: "assistant", content: "Done." } },
        ],
      },
      ui: { notify: () => undefined },
    };

    await handler?.({ message: { role: "assistant", content: "done" } }, ctx);
    await Promise.resolve();

    const prompt = execCalls[0]?.args.at(-1) ?? "";
    expect(prompt).toContain("Consolidation-as-promotion candidates");
    expect(prompt).toContain("Projects/Piren/log.md");
    expect(prompt).toContain("raw entries stay as evidence");
  });

  it("includes opt-in self-improvement notes in the startup context prompt", async () => {
    const pi = fakePi();
    await extension(pi as any, {
      cliAgentDir: agentDir,
      env: {},
      configPath: join(root, "missing-config.yml"),
    });
    const beforeStart = pi.events.before_agent_start?.[0];
    const out = await beforeStart?.();
    const content = (out as { message: { content: string } }).message.content;
    expect(content).toContain("opt-in");
    expect(content).toContain("PIREN_AUTO_NUDGE");
    expect(content).toContain("self_improvement.auto_nudge");
    expect(content).toContain("review loop");
    expect(content).toContain("PIREN_REVIEW_LOOP=1");
    expect(content).toContain("self_improvement.review_loop.enabled");
    expect(content).toContain("Nothing to promote");
  });
});
