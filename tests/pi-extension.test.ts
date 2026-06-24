import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

    expect(Object.keys(pi.tools).sort()).toEqual(["flag_steward", "inbox_list", "send_to_agent", "session_write_summary", "task_claim", "task_update_status", "vault_append_log", "vault_list", "vault_patch", "vault_read", "vault_read_cached", "vault_write"]);
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
    expect(notifications[0]?.message).toContain("registered_tools: flag_steward, inbox_list, send_to_agent, session_write_summary, task_claim, task_update_status, vault_append_log, vault_list, vault_patch, vault_read, vault_read_cached, vault_write");
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
    expect(content).toMatch(/only.*steward.*asks|only.*worker.*mode/i);
  });
});
