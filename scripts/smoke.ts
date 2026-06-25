import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/pi-extension.js";
import { formatAgentsReport, listPirenAgents } from "../src/agents.js";
import { buildPiRunCommand } from "../src/run.js";
import { doctorPiren } from "../src/doctor.js";
import { PiRpcClient, extractAssistantText } from "../src/gateway-rpc.js";
import { GatewayServer } from "../src/gateway-http.js";
import { askAgent } from "../src/ask.js";

type FakePi = ReturnType<typeof fakePi>;

function fakePi() {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const events: Record<string, Function[]> = {};
  return {
    tools,
    commands,
    events,
    registerFlag() {},
    getFlag() { return undefined; },
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(event: string, handler: Function) {
      events[event] ??= [];
      events[event].push(handler);
    },
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "piren-smoke-"));
  const vault = join(root, "vault");
  const agentDir = join(vault, "team", "thor");
  await mkdir(join(agentDir, "inbox"), { recursive: true });
  await mkdir(join(agentDir, "outbox"), { recursive: true });
  await mkdir(join(agentDir, "logs"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
  await writeFile(join(vault, "steward-directives.md"), "# Steward Directives\nKeep the spike small and boring.\n");
  await writeFile(join(agentDir, "SOUL.md"), "# Thor\nYou are Thor for the Piren spike.\n");
  await writeFile(join(agentDir, "MEMORY.md"), "# Memory\n");
  await writeFile(join(agentDir, "config.yml"), "model:\n  id: anthropic/claude-sonnet-4-20250514\n  thinking: medium\n");
  return { root, vault, agentDir };
}

async function load(label: string, agentDir: string, configPath: string, env: Record<string, string | undefined> = {}): Promise<FakePi> {
  const pi = fakePi();
  await extension(pi as any, { cliAgentDir: agentDir, env, configPath });
  console.log(`${label}: loaded tools=${Object.keys(pi.tools).sort().join(",")} commands=${Object.keys(pi.commands).sort().join(",")}`);
  return pi;
}

async function main() {
  const fixture = await createFixture();
  const configPath = join(fixture.root, "missing-config.yml");
  const localCache = join(fixture.root, "local-cache");
  await mkdir(join(localCache, "team", "thor", "logs"), { recursive: true });
  await writeFile(join(localCache, "team", "thor", "logs", "cached.md"), "cached smoke copy\n");
  const env = { PIREN_LOCAL_CACHE_DIR: localCache, PIREN_DEVICE_ID: "heimdall", PIREN_HOSTNAME: "heimdall.local" };
  try {
    const pi = await load("start", fixture.agentDir, configPath, env);
    console.log(`derived vault_root=${fixture.vault}`);
    console.log(`derived agent_dir=${fixture.agentDir}`);

    const deviceRecord = JSON.parse(await readFile(join(fixture.vault, "team", "thor", "devices", "heimdall.json"), "utf8"));
    if (deviceRecord.device_id !== "heimdall" || deviceRecord.hostname !== "heimdall.local" || deviceRecord.status !== "active") {
      throw new Error("device registration smoke failed");
    }
    console.log("device registration team/thor/devices/heimdall.json: ok");

    const statusNotifications: string[] = [];
    await pi.commands.piren_status.handler([], {
      ui: {
        notify(message: string) {
          statusNotifications.push(message);
        },
      },
    });
    if (!statusNotifications[0]?.includes("Piren status") || !statusNotifications[0].includes("write_mode: authoritative-vault")) {
      throw new Error("piren_status smoke failed");
    }
    console.log("piren_status command: ok");

    // ADR-0017 lazy vault skills: shared skill in vault/skills/ and agent-specific
    // skill in team/thor/skills/. The startup prompt gets only a compact catalog;
    // full bodies are loaded explicitly with skill_read(name).
    await mkdir(join(fixture.vault, "skills"), { recursive: true });
    await mkdir(join(fixture.vault, "team", "thor", "skills"), { recursive: true });
    await writeFile(
      join(fixture.vault, "skills", "check-disk.md"),
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
    await writeFile(
      join(fixture.vault, "team", "thor", "skills", "deploy.md"),
      [
        "---",
        "name: deploy",
        'description: "Deploy the app to staging."',
        "---",
        "",
        "# Deploy",
      ].join("\n"),
    );
    const skillPi = await load("skills", fixture.agentDir, configPath, env);
    const skillStatusNotifications: string[] = [];
    await skillPi.commands.piren_status.handler([], {
      ui: {
        notify(message: string) {
          skillStatusNotifications.push(message);
        },
      },
    });
    if (!skillStatusNotifications[0]?.includes("skills_loaded: 2")) {
      throw new Error(`piren_status skills smoke failed: ${skillStatusNotifications[0]}`);
    }
    const skillBeforeStart = skillPi.events.before_agent_start?.[0];
    if (!skillBeforeStart) throw new Error("skills before_agent_start handler not found");
    const skillResult = await skillBeforeStart();
    const skillContent = (skillResult as { message: { content: string } }).message.content;
    if (!skillContent.includes("Available Skills") || !skillContent.includes("check-disk") || !skillContent.includes("deploy") || !skillContent.includes("skill_read(name)")) {
      throw new Error("context prompt did not include lazy vault skill catalog");
    }
    if (skillContent.includes("# Check Disk") || skillContent.includes("Run df -h") || skillContent.includes("# Deploy")) {
      throw new Error("context prompt included full skill bodies instead of catalog only");
    }
    const skillList = await skillPi.tools.skill_list.execute("smoke-skill-list", {});
    if (skillList.isError || skillList.details.skills.length !== 2 || !skillList.content[0].text.includes("check-disk")) {
      throw new Error("skill_list smoke failed");
    }
    const skillRead = await skillPi.tools.skill_read.execute("smoke-skill-read", { name: "check-disk" });
    if (skillRead.isError || !skillRead.content[0].text.includes("# Check Disk") || !skillRead.content[0].text.includes("Run df -h")) {
      throw new Error("skill_read smoke failed");
    }
    console.log("vault skills lazy catalog + skill_read + status: ok");

    const read = await pi.tools.vault_read.execute("smoke-read", { path: "steward-directives.md" });
    if (read.isError || !read.content[0].text.includes("Keep the spike")) throw new Error("vault_read smoke failed");
    console.log("vault_read steward-directives.md: ok");

    const cachedRead = await pi.tools.vault_read_cached.execute("smoke-cached-read", { path: "team/thor/logs/cached.md" });
    if (cachedRead.isError || cachedRead.content[0].text !== "cached smoke copy\n" || cachedRead.details.authoritative !== false) {
      throw new Error("vault_read_cached smoke failed");
    }
    console.log("vault_read_cached team/thor/logs/cached.md: ok");

    const write = await pi.tools.vault_write.execute("smoke-write", {
      path: "team/thor/logs/spike-test.md",
      content: "# Spike Test\nPiren vault_write smoke passed.\n",
    });
    if (write.isError) throw new Error(`vault_write smoke failed: ${write.content[0].text}`);
    const written = await readFile(join(fixture.vault, "team", "thor", "logs", "spike-test.md"), "utf8");
    if (!written.includes("Piren vault_write smoke passed")) throw new Error("written file did not contain expected content");
    console.log("vault_write team/thor/logs/spike-test.md: ok");

    const list = await pi.tools.vault_list.execute("smoke-list", { path: "team/thor/logs" });
    if (list.isError || !list.details.entries.some((entry: any) => entry.path === "team/thor/logs/spike-test.md")) {
      throw new Error("vault_list smoke failed");
    }
    console.log("vault_list team/thor/logs: ok");

    const patch = await pi.tools.vault_patch.execute("smoke-patch", {
      path: "team/thor/logs/spike-test.md",
      old_text: "Piren vault_write smoke passed.",
      new_text: "Piren vault_patch smoke passed.",
    });
    if (patch.isError) throw new Error(`vault_patch smoke failed: ${patch.content[0].text}`);
    const patched = await readFile(join(fixture.vault, "team", "thor", "logs", "spike-test.md"), "utf8");
    if (!patched.includes("Piren vault_patch smoke passed")) throw new Error("patched file did not contain expected content");
    console.log("vault_patch team/thor/logs/spike-test.md: ok");

    const appendLog = await pi.tools.vault_append_log.execute("smoke-append-log", {
      path: "team/thor/logs/activity.md",
      entry: "Smoke append-log passed.",
    });
    if (appendLog.isError) throw new Error(`vault_append_log smoke failed: ${appendLog.content[0].text}`);
    const activity = await readFile(join(fixture.vault, "team", "thor", "logs", "activity.md"), "utf8");
    if (!activity.includes("Smoke append-log passed.")) throw new Error("activity log did not contain expected content");
    console.log("vault_append_log team/thor/logs/activity.md: ok");

    const sessionSummary = await pi.tools.session_write_summary.execute("smoke-session-summary", {
      title: "Smoke Session",
      summary: "Piren session summary smoke passed.",
    });
    if (sessionSummary.isError) throw new Error(`session_write_summary smoke failed: ${sessionSummary.content[0].text}`);
    const summaryContent = await readFile(join(fixture.vault, sessionSummary.details.path), "utf8");
    if (!summaryContent.includes("Piren session summary smoke passed.")) throw new Error("session summary did not contain expected content");
    console.log("session_write_summary team/thor/sessions: ok");

    const alert = await pi.tools.flag_steward.execute("smoke-flag-steward", {
      title: "Vault unavailable",
      body: "Smoke alert asks the steward to inspect vault availability.",
      severity: "high",
      notify: true,
    });
    if (alert.isError) throw new Error(`flag_steward smoke failed: ${alert.content[0].text}`);
    const alertContent = await readFile(join(fixture.vault, alert.details.path), "utf8");
    if (!alertContent.includes("# Vault unavailable") || !alertContent.includes("severity: high") || !alertContent.includes("Smoke alert asks the steward")) {
      throw new Error("flag_steward alert did not contain expected content");
    }
    console.log("flag_steward steward-inbox/alerts: ok");

    // Phase 4 knowledge lifecycle tools: project_status, project_append_log,
    // and decision_record. Agents leave durable artifacts after non-trivial work.
    await mkdir(join(fixture.vault, "Projects", "Piren", "decisions"), { recursive: true });
    await writeFile(
      join(fixture.vault, "Projects", "Piren", "index.md"),
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
    const statusResult = await pi.tools.project_status.execute("smoke-status", { project: "Piren" });
    if (statusResult.isError || !statusResult.details.available || statusResult.details.status !== "phase-4-knowledge") {
      throw new Error(`project_status smoke failed: ${statusResult.content[0].text}`);
    }
    console.log("project_status Projects/Piren: ok");

    const logResult = await pi.tools.project_append_log.execute("smoke-log", {
      project: "Piren",
      entry: "Knowledge lifecycle tools smoke passed.",
    });
    if (logResult.isError) throw new Error(`project_append_log smoke failed: ${logResult.content[0].text}`);
    const logContent = await readFile(join(fixture.vault, "Projects", "Piren", "log.md"), "utf8");
    if (!logContent.includes("Knowledge lifecycle tools smoke passed.")) {
      throw new Error("project log did not contain expected entry");
    }
    console.log("project_append_log Projects/Piren/log.md: ok");

    const adrResult = await pi.tools.decision_record.execute("smoke-adr", {
      project: "Piren",
      id: "0015",
      title: "Knowledge Lifecycle Tools",
      context: "Agents need explicit tools to leave durable artifacts.",
      decision: "Add project_status, project_append_log, and decision_record.",
    });
    if (adrResult.isError) throw new Error(`decision_record smoke failed: ${adrResult.content[0].text}`);
    const adrContent = await readFile(join(fixture.vault, "Projects", "Piren", "decisions", "ADR-0015-knowledge-lifecycle-tools.md"), "utf8");
    if (!adrContent.includes("# ADR-0015 - Knowledge Lifecycle Tools") || !adrContent.includes("## Decision")) {
      throw new Error("ADR did not contain expected content");
    }
    console.log("decision_record Projects/Piren/decisions: ok");

    const handoffResult = await pi.tools.project_update_handoff.execute("smoke-handoff", {
      project: "Piren",
      content: "# Handoff\n\nContinue with vault-backed cron.\n",
    });
    if (handoffResult.isError) throw new Error(`project_update_handoff smoke failed: ${handoffResult.content[0].text}`);
    const handoffContent = await readFile(join(fixture.vault, "Projects", "Piren", "handoff-prompt.md"), "utf8");
    if (!handoffContent.includes("Continue with vault-backed cron.")) {
      throw new Error("handoff prompt did not contain expected content");
    }
    console.log("project_update_handoff Projects/Piren/handoff-prompt.md: ok");

    const runbookResult = await pi.tools.runbook_write.execute("smoke-runbook", {
      project: "Piren",
      title: "Gateway Recovery",
      content: "Restart the gateway and inspect logs.",
    });
    if (runbookResult.isError) throw new Error(`runbook_write smoke failed: ${runbookResult.content[0].text}`);
    const runbookContent = await readFile(join(fixture.vault, "Projects", "Piren", "runbooks", "gateway-recovery.md"), "utf8");
    if (!runbookContent.includes("# Gateway Recovery") || !runbookContent.includes("Restart the gateway")) {
      throw new Error("runbook did not contain expected content");
    }
    console.log("runbook_write Projects/Piren/runbooks: ok");

    const candidateResult = await pi.tools.skill_candidate_write.execute("smoke-skill-candidate", {
      name: "release-checklist",
      description: "Verify a Piren release candidate.",
      body: "Run tests, typecheck, build, and smoke.",
      scope: "Piren",
    });
    if (candidateResult.isError) throw new Error(`skill_candidate_write smoke failed: ${candidateResult.content[0].text}`);
    const candidateContent = await readFile(join(fixture.vault, "Projects", "Piren", "skill-candidates", "release-checklist.md"), "utf8");
    if (!candidateContent.includes("status: candidate") || !candidateContent.includes("Run tests, typecheck, build, and smoke.")) {
      throw new Error("skill candidate did not contain expected content");
    }
    console.log("skill_candidate_write Projects/Piren/skill-candidates: ok");

    // ADR-0019: vault-backed cron. A shared job file is listed as due, claimed
    // atomically, run with an inspectable run record, restored with last_run
    // set, and visible in cron_runs history. Secrets never go in job files.
    await mkdir(join(fixture.vault, "cron", "jobs"), { recursive: true });
    await writeFile(
      join(fixture.vault, "cron", "jobs", "smoke-digest.md"),
      [
        "---",
        "id: smoke-digest",
        'agent: "thor"',
        'schedule: "0 7 * * *"',
        "enabled: true",
        "---",
        "",
        "# Prompt",
        "",
        "Summarize smoke project logs.",
        "",
      ].join("\n"),
    );
    const cronList = await pi.tools.cron_list.execute("smoke-cron-list", {});
    if (cronList.isError || !cronList.details.jobs.some((j: any) => j.id === "smoke-digest")) {
      throw new Error(`cron_list smoke failed: ${cronList.content[0].text}`);
    }
    console.log("cron_list cron/jobs: ok");

    const cronClaim = await pi.tools.cron_claim.execute("smoke-cron-claim", { job_path: "cron/jobs/smoke-digest.md", device_id: "heimdall" });
    if (cronClaim.isError) throw new Error(`cron_claim smoke failed: ${cronClaim.content[0].text}`);
    if (cronClaim.details.path !== "cron/jobs/smoke-digest.claimed.heimdall.md") {
      throw new Error(`cron_claim did not report expected claimed path: ${cronClaim.details.path}`);
    }
    console.log("cron_claim cron/jobs: ok");

    const cronRecord = await pi.tools.cron_record_run.execute("smoke-cron-record", {
      job_path: cronClaim.details.path,
      status: "completed",
      result: "Smoke cron digest produced.",
      started_at: "2026-06-25T07:00:05.000Z",
      finished_at: "2026-06-25T07:00:42.000Z",
    });
    if (cronRecord.isError) throw new Error(`cron_record_run smoke failed: ${cronRecord.content[0].text}`);
    const cronRunContent = await readFile(join(fixture.vault, cronRecord.details.runPath), "utf8");
    if (!cronRunContent.includes("status: completed") || !cronRunContent.includes("device: heimdall") || !cronRunContent.includes("Smoke cron digest produced.")) {
      throw new Error("cron run record did not contain expected content");
    }
    const cronRestored = await readFile(join(fixture.vault, "cron", "jobs", "smoke-digest.md"), "utf8");
    if (!cronRestored.includes("last_run: 2026-06-25T07:00:42.000Z")) {
      throw new Error("cron job was not restored with last_run set");
    }
    console.log("cron_record_run cron/runs: ok");

    const cronRuns = await pi.tools.cron_runs.execute("smoke-cron-runs", {});
    if (cronRuns.isError || !cronRuns.details.runs.some((r: any) => r.jobId === "smoke-digest")) {
      throw new Error(`cron_runs smoke failed: ${cronRuns.content[0].text}`);
    }
    console.log("cron_runs history: ok");

    const sentTask = await pi.tools.send_to_agent.execute("smoke-send", {
      to: "thor",
      title: "Check smoke inbox",
      body: "Confirm send_to_agent creates one inbox task file.",
    });
    if (sentTask.isError) throw new Error(`send_to_agent smoke failed: ${sentTask.content[0].text}`);
    const taskContent = await readFile(join(fixture.vault, sentTask.details.path), "utf8");
    if (!taskContent.includes("status: pending") || !taskContent.includes("# Check smoke inbox")) {
      throw new Error("send_to_agent task did not contain expected content");
    }
    console.log("send_to_agent team/thor/inbox: ok");

    const updatedTask = await pi.tools.task_update_status.execute("smoke-task-update", {
      task_path: sentTask.details.path,
      status: "completed",
      result: "Smoke inbox task completed.",
    });
    if (updatedTask.isError) throw new Error(`task_update_status smoke failed: ${updatedTask.content[0].text}`);
    const updatedTaskContent = await readFile(join(fixture.vault, sentTask.details.path), "utf8");
    if (!updatedTaskContent.includes("status: completed") || !updatedTaskContent.includes("Smoke inbox task completed.")) {
      throw new Error("task_update_status did not update expected task content");
    }
    console.log("task_update_status team/thor/inbox: ok");

    const inboxList = await pi.tools.inbox_list.execute("smoke-inbox-list", {});
    if (inboxList.isError) throw new Error(`inbox_list smoke failed: ${inboxList.content[0].text}`);
    if (!inboxList.content[0].text.includes("completed\tCheck smoke inbox") || inboxList.details.tasks.length !== 1) {
      throw new Error("inbox_list did not report expected task");
    }
    console.log("inbox_list team/thor/inbox: ok");

    const claimedTask = await pi.tools.task_claim.execute("smoke-task-claim", {
      task_path: sentTask.details.path,
      device_id: "heimdall",
    });
    if (claimedTask.isError) throw new Error(`task_claim smoke failed: ${claimedTask.content[0].text}`);
    if (!claimedTask.details.path.includes(".claimed.heimdall.md") || claimedTask.details.originalPath !== sentTask.details.path) {
      throw new Error("task_claim did not report expected claimed path");
    }
    try {
      await readFile(join(fixture.vault, sentTask.details.path), "utf8");
      throw new Error("task_claim left original task path in place");
    } catch (error) {
      if (error instanceof Error && error.message === "task_claim left original task path in place") throw error;
    }
    console.log("task_claim team/thor/inbox: ok");

    await writeFile(join(fixture.vault, "team", "thor", "devices", "heimdall.json"), JSON.stringify({
      device_id: "heimdall",
      hostname: "heimdall.local",
      priority: 10,
      status: "active",
      started_at: "2026-06-22T16:00:00.000Z",
      last_seen: "2026-06-22T16:00:00.000Z",
    }, null, 2) + "\n");
    const reclaimedTask = await pi.tools.task_claim.execute("smoke-task-reclaim", {
      task_path: claimedTask.details.path,
      device_id: "thor-laptop",
      stale_after_ms: 5 * 60 * 1000,
      now: "2026-06-22T16:10:01.000Z",
    });
    if (reclaimedTask.isError) throw new Error(`stale task_claim recovery smoke failed: ${reclaimedTask.content[0].text}`);
    if (!reclaimedTask.details.path.includes(".claimed.thor-laptop.md") || reclaimedTask.details.originalPath !== claimedTask.details.path) {
      throw new Error("stale task_claim recovery did not report expected reclaimed path");
    }
    try {
      await readFile(join(fixture.vault, claimedTask.details.path), "utf8");
      throw new Error("stale task_claim recovery left old claim path in place");
    } catch (error) {
      if (error instanceof Error && error.message === "stale task_claim recovery left old claim path in place") throw error;
    }
    console.log("stale task_claim recovery via device heartbeat: ok");

    const inboxAfterClaim = await pi.tools.inbox_list.execute("smoke-inbox-list-after-claim", {});
    if (inboxAfterClaim.isError || inboxAfterClaim.details.tasks.length !== 0) {
      throw new Error("inbox_list should not show claimed tasks");
    }
    console.log("inbox_list after task_claim: ok");

    const outside = await pi.tools.vault_write.execute("smoke-outside", { path: "../outside.md", content: "nope" });
    if (!outside.isError || !outside.content[0].text.match(/outside vault/i)) throw new Error("outside write was not rejected");
    console.log("vault_write ../outside.md rejected: ok");

    const reloaded = await load("reload", fixture.agentDir, configPath, env);
    const reloadRead = await reloaded.tools.vault_read.execute("smoke-reload-read", { path: "steward-directives.md" });
    if (reloadRead.isError) throw new Error("reload read failed");
    console.log("reload repeat read: ok");

    const restarted = await load("restart", fixture.agentDir, configPath, env);
    const restartRead = await restarted.tools.vault_read.execute("smoke-restart-read", { path: "steward-directives.md" });
    if (restartRead.isError) throw new Error("restart read failed");
    const restartWrite = await restarted.tools.vault_write.execute("smoke-restart-write", {
      path: "team/thor/logs/spike-test-restart.md",
      content: "restart write ok\n",
    });
    if (restartWrite.isError) throw new Error("restart write failed");
    const piCommand = await buildPiRunCommand({ cliAgentDir: fixture.agentDir, env: {}, configPath, extraArgs: ["--print", "hello"] });
    const piCommandText = [piCommand.command, ...piCommand.args].join(" ");
    if (!piCommand.args.includes("--model") || !piCommand.args.includes("anthropic/claude-sonnet-4-20250514:medium")) {
      throw new Error(`piren run command did not include expected model flag: ${piCommandText}`);
    }
    if (!piCommandText.includes("--extension") || !piCommandText.includes(`--vault-root ${fixture.vault}`) || !piCommandText.includes("--agent thor")) {
      throw new Error(`piren run command did not include expected bootstrap flags: ${piCommandText}`);
    }
    if (!piCommandText.endsWith("--print hello")) {
      throw new Error(`piren run command did not forward extra args: ${piCommandText}`);
    }
    console.log(`piren run command: ${piCommandText}`);

    // ADR-0013: Pi package extensibility. Declared packages in config.yml are
    // resolved to entry points and appended as --extension flags. piren doctor
    // validates installed packages. piren_status reports declared packages.
    const packageConfigPath = join(fixture.root, "package-config.yml");
    await writeFile(packageConfigPath, "vault_root: " + fixture.vault + "\n" + "allowed_agents:\n" + "  - thor\n" + "packages:\n" + '  - "@piren/web-search"\n' + '  - "@piren/git-tools"\n');
    const fakePackageResolver = (name: string) => "/fake/node_modules/" + name + "/dist/index.js";
    const pkgCommand = await buildPiRunCommand({ cliAgentDir: fixture.agentDir, env: {}, configPath: packageConfigPath, extensionPath: "./src/pi-extension.ts", packageResolver: fakePackageResolver });
    const extensionFlags = pkgCommand.args.reduce<string[]>((acc, arg, i) => {
      if (arg === "--extension") acc.push(pkgCommand.args[i + 1] ?? "");
      return acc;
    }, []);
    if (extensionFlags.length !== 3 || extensionFlags[0] !== "./src/pi-extension.ts" || extensionFlags[1] !== "/fake/node_modules/@piren/web-search/dist/index.js" || extensionFlags[2] !== "/fake/node_modules/@piren/git-tools/dist/index.js") {
      throw new Error(`package extensions not appended in order: ${extensionFlags.join(", ")}`);
    }
    console.log("piren run command with packages: ok");

    // piren doctor validates declared packages.
    const doctorReport = await doctorPiren({ cliAgent: "thor", env: {}, configPath: packageConfigPath, packageResolver: fakePackageResolver });
    const packagesCheck = doctorReport.checks.find((c: { id: string; status: string }) => c.id === "packages");
    if (!packagesCheck || packagesCheck.status !== "ok") {
      throw new Error(`doctor packages check failed: ${packagesCheck?.status} ${packagesCheck?.message}`);
    }
    if (!doctorReport.packages.includes("@piren/web-search") || !doctorReport.packages.includes("@piren/git-tools")) {
      throw new Error(`doctor report missing packages: ${doctorReport.packages.join(", ")}`);
    }
    console.log("piren doctor packages validation: ok");

    // piren doctor warns about missing packages.
    const missingResolver = (name: string) => {
      if (name === "@piren/git-tools") throw new Error("Cannot find module");
      return "/fake/node_modules/" + name + "/index.js";
    };
    const missingDoctorReport = await doctorPiren({ cliAgent: "thor", env: {}, configPath: packageConfigPath, packageResolver: missingResolver });
    const missingPackagesCheck = missingDoctorReport.checks.find((c: { id: string; status: string }) => c.id === "packages");
    if (!missingPackagesCheck || missingPackagesCheck.status !== "warn") {
      throw new Error(`doctor missing packages check should warn: ${missingPackagesCheck?.status}`);
    }
    console.log("piren doctor missing packages warning: ok");

    // piren_status reports declared packages.
    const statusPi = await load("packages-status", fixture.agentDir, packageConfigPath, env);
    const pkgStatusNotifications: string[] = [];
    await statusPi.commands.piren_status.handler([], {
      ui: {
        notify(message: string) {
          pkgStatusNotifications.push(message);
        },
      },
    });
    if (!pkgStatusNotifications[0]?.includes("packages: @piren/web-search, @piren/git-tools")) {
      throw new Error(`piren_status did not report packages: ${pkgStatusNotifications[0]}`);
    }
    console.log("piren_status packages reporting: ok");

    const agentsReport = await listPirenAgents({ cliVaultRoot: fixture.vault, configPath });
    const agentsOutput = formatAgentsReport(agentsReport);
    if (!agentsOutput.includes("[runnable] thor")) {
      throw new Error(`piren agents smoke failed: ${agentsOutput}`);
    }
    console.log("piren agents listing: ok");

    const workerConfigPath = join(fixture.root, "worker-config.yml");
    await writeFile(workerConfigPath, "vault_root: " + fixture.vault + "\n" + "allowed_agents:\n" + "  - thor\n");
    const worker = await load("worker", fixture.agentDir, workerConfigPath, { ...env, PIREN_WORKER: "1" });
    const workerTask = await worker.tools.send_to_agent.execute("smoke-worker-send", {
      to: "thor",
      title: "Worker inbox poll",
      body: "Worker mode should report this task on session start.",
    });
    if (workerTask.isError) throw new Error(`worker send_to_agent smoke failed: ${workerTask.content[0].text}`);
    const workerNotifications: string[] = [];
    await worker.events.session_start?.[0]?.({}, {
      ui: {
        notify(message: string) {
          workerNotifications.push(message);
        },
      },
    });
    if (!workerNotifications.some((message) => message.includes("Worker inbox poll: 1 task(s) available") && message.includes("Worker inbox poll"))) {
      throw new Error(`worker inbox polling smoke failed: ${workerNotifications.join("\n")}`);
    }
    console.log("worker inbox polling on session_start: ok");

    // Phase 3 tracer bullet 1: a separate process speaks to Pi RPC over strict
    // LF-only JSONL and returns a streamed response. Here a fake Pi process
    // stands in for real `pi --mode rpc` so the round-trip needs no model auth.
    const rpcCommand = await buildPiRunCommand({ cliAgentDir: fixture.agentDir, env: {}, configPath, rpcMode: true });
    const rpcCommandText = [rpcCommand.command, ...rpcCommand.args].join(" ");
    if (!rpcCommand.args.includes("--mode") || !rpcCommand.args.includes("rpc") || rpcCommand.stdio !== "pipe") {
      throw new Error(`gateway RPC command did not activate --mode rpc with piped stdio: ${rpcCommandText}`);
    }
    console.log(`piren gateway rpc command: ${rpcCommandText}`);

    const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");
    const rpcClient = new PiRpcClient({ command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env });
    try {
      await rpcClient.start();
      const rpcEvents = await rpcClient.promptAndWait("Hello");
      const lastType = rpcEvents[rpcEvents.length - 1]?.type;
      const rpcText = extractAssistantText(rpcEvents);
      if (lastType !== "agent_end") throw new Error(`RPC stream did not end with agent_end: ${lastType}`);
      if (rpcText !== "Hello") throw new Error(`RPC streamed text mismatch: ${rpcText}`);
    } finally {
      await rpcClient.stop();
    }
    console.log("gateway rpc prompt->agent_end streamed text: ok");

    // Phase 3 tracer bullet 2: a real HTTP/SSE round trip on the proven RPC
    // client. POST /api/chat/start kicks off the turn; GET /api/chat/stream
    // drains bridge-translated SSE events until done. A fake Pi process stands
    // in for real `pi --mode rpc` so the round trip needs no model auth.
    const gateway = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
    });
    let gatewayHandle;
    try {
      gatewayHandle = await gateway.start();
      const startRes = await fetch(`http://${gatewayHandle.hostname}:${gatewayHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      if (startRes.status !== 200) throw new Error(`gateway start HTTP ${startRes.status}`);
      const { stream_id } = (await startRes.json()) as { stream_id: string };
      const streamRes = await fetch(`http://${gatewayHandle.hostname}:${gatewayHandle.port}/api/chat/stream?stream_id=${stream_id}`);
      if (streamRes.headers.get("content-type") !== "text/event-stream") {
        throw new Error("gateway stream did not return text/event-stream");
      }
      const sseText = await streamRes.text();
      const tokens: string[] = [];
      let sawDone = false;
      for (const block of sseText.split("\n\n")) {
        if (!block.trim() || block.startsWith(":")) continue;
        let evt = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) evt = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (evt === "token") tokens.push((JSON.parse(data) as { text: string }).text);
        else if (evt === "done") sawDone = true;
      }
      if (!sawDone) throw new Error("gateway SSE stream did not end with done");
      if (tokens.join("") !== "Hello") throw new Error(`gateway streamed text mismatch: ${tokens.join("")}`);
    } finally {
      await gateway.close();
    }
    console.log("gateway http/sse post-start get-stream streamed text: ok");

    // Phase 3 tracer bullet 3: vault browser HTTP routes. Start a GatewayServer
    // with vaultRoot set (same fake Pi target), then do one list + one read
    // round trip against the fixture vault.
    const browserServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
      vaultRoot: fixture.vault,
    });
    let browserHandle;
    try {
      browserHandle = await browserServer.start();

      // List the vault root.
      const listRes = await fetch(
        `http://${browserHandle.hostname}:${browserHandle.port}/api/vault/list`,
      );
      if (listRes.status !== 200) throw new Error(`vault browser list HTTP ${listRes.status}`);
      const listBody = (await listRes.json()) as { entries: Array<{ name: string; type: string }>; capped: boolean };
      const teamEntry = listBody.entries.find((e) => e.name === "team");
      if (!teamEntry || teamEntry.type !== "directory") {
        throw new Error("vault browser list did not include team directory");
      }

      // Read steward-directives.md.
      const readRes = await fetch(
        `http://${browserHandle.hostname}:${browserHandle.port}/api/vault/read?path=steward-directives.md`,
      );
      if (readRes.status !== 200) throw new Error(`vault browser read HTTP ${readRes.status}`);
      const readBody = (await readRes.json()) as { content: string; path: string };
      if (!readBody.content.includes("Keep the spike")) {
        throw new Error("vault browser read did not return expected content");
      }
      if (readBody.path !== "steward-directives.md") {
        throw new Error(`vault browser read path mismatch: ${readBody.path}`);
      }
    } finally {
      await browserServer.close();
    }
    console.log("gateway vault browser list+read round trip: ok");

    // piren ask: the same PiRpcClient, but as a CLI one-shot wrapper.
    // The askAgent function drives the same fake Pi, streaming tokens live.
    let askTokens = "";
    const askText = await askAgent(
      { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
      "Hello",
      (token) => { askTokens += token; },
    );
    if (askText !== "Hello" || askTokens !== "Hello") {
      throw new Error(`askAgent assembled text mismatch: text=${askText} tokens=${askTokens}`);
    }
    console.log("piren ask streamed text: ok");

    // Phase 3 tracer bullet 4: model/thinking/state routes and agent switching.
    // Reuse the fake Pi target. The gateway owns one client; the new routes
    // reach through it to Pi's native RPC capabilities.
    const modelServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
      runnableAgents: ["piren", "thor"],
      initialAgent: "piren",
      targetBuilder: async () => ({ command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env }),
    });
    let modelHandle;
    try {
      modelHandle = await modelServer.start();

      // GET /api/chat/models
      const modelsRes = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/models`);
      if (modelsRes.status !== 200) throw new Error(`models HTTP ${modelsRes.status}`);
      const modelsBody = (await modelsRes.json()) as { models: Array<{ id: string }> };
      if (modelsBody.models.length === 0) throw new Error("models list is empty");

      // GET /api/chat/state
      const stateRes = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/state`);
      if (stateRes.status !== 200) throw new Error(`state HTTP ${stateRes.status}`);
      const stateBody = (await stateRes.json()) as { sessionId: string };
      if (stateBody.sessionId !== "fake-session") throw new Error("state sessionId mismatch");

      // POST /api/chat/model
      const setModelRes = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" }),
      });
      if (setModelRes.status !== 200) throw new Error(`set model HTTP ${setModelRes.status}`);

      // POST /api/chat/thinking
      const thinkingRes = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "medium" }),
      });
      if (thinkingRes.status !== 200) throw new Error(`set thinking HTTP ${thinkingRes.status}`);

      // GET /api/chat/agents
      const agentsRes = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/agents`);
      if (agentsRes.status !== 200) throw new Error(`agents HTTP ${agentsRes.status}`);
      const agentsBody = (await agentsRes.json()) as { agents: string[]; current: string };
      if (agentsBody.agents.length !== 2 || agentsBody.current !== "piren") {
        throw new Error(`agents body mismatch: ${JSON.stringify(agentsBody)}`);
      }

      // POST /api/chat/switch
      const switchRes = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "thor" }),
      });
      if (switchRes.status !== 200) throw new Error(`switch HTTP ${switchRes.status}`);
      const switchBody = (await switchRes.json()) as { agent: string; switched: boolean };
      if (switchBody.agent !== "thor" || !switchBody.switched) {
        throw new Error(`switch body mismatch: ${JSON.stringify(switchBody)}`);
      }

      // Verify the switch took effect.
      const agentsAfter = await fetch(`http://${modelHandle.hostname}:${modelHandle.port}/api/chat/agents`);
      const agentsAfterBody = (await agentsAfter.json()) as { current: string };
      if (agentsAfterBody.current !== "thor") throw new Error("agent did not switch to thor");
    } finally {
      await modelServer.close();
    }
    console.log("gateway model/state/thinking/agents/switch round trip: ok");

    // Phase 3 tracer bullet 5: steering and approval gates.
    const steerServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
    });
    let steerHandle;
    try {
      steerHandle = await steerServer.start();

      // Start a normal prompt.
      const startRes = await fetch(`http://${steerHandle.hostname}:${steerHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      if (startRes.status !== 200) throw new Error(`start HTTP ${startRes.status}`);

      // Send a steer.
      const steerRes = await fetch(`http://${steerHandle.hostname}:${steerHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "wait", mode: "steer" }),
      });
      if (steerRes.status !== 200) throw new Error(`steer HTTP ${steerRes.status}`);

      // Send a follow-up.
      const followRes = await fetch(`http://${steerHandle.hostname}:${steerHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "then do this", mode: "follow_up" }),
      });
      if (followRes.status !== 200) throw new Error(`follow_up HTTP ${followRes.status}`);

      // Invalid mode is rejected.
      const badModeRes = await fetch(`http://${steerHandle.hostname}:${steerHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", mode: "bogus" }),
      });
      if (badModeRes.status !== 400) throw new Error(`bad mode HTTP ${badModeRes.status}`);

      // Approval: start a prompt that triggers an extension_ui_request, then
      // respond to it via the approve route.
      const approveStartRes = await fetch(`http://${steerHandle.hostname}:${steerHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "please approve this action" }),
      });
      if (approveStartRes.status !== 200) throw new Error(`approve-start HTTP ${approveStartRes.status}`);

      const approveRes = await fetch(`http://${steerHandle.hostname}:${steerHandle.port}/api/chat/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ui-req-smoke", confirmed: true }),
      });
      if (approveRes.status !== 200) throw new Error(`approve HTTP ${approveRes.status}`);
    } finally {
      await steerServer.close();
    }
    console.log("gateway steer/follow_up/approve round trip: ok");

    // Phase 3 tracer bullet 6: auth token gate. A server with a configured
    // authToken rejects unauthenticated API requests (401), accepts requests
    // with the correct Bearer token, exposes authRequired via a public
    // /api/auth/info route, and does not enforce auth when no token is set.
    const authServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
      authToken: "smoke-secret-token",
    });
    let authHandle;
    try {
      authHandle = await authServer.start();

      // /api/auth/info is public and reports authRequired=true.
      const infoRes = await fetch(`http://${authHandle.hostname}:${authHandle.port}/api/auth/info`);
      if (infoRes.status !== 200) throw new Error(`auth info HTTP ${infoRes.status}`);
      const infoBody = (await infoRes.json()) as { authRequired: boolean };
      if (!infoBody.authRequired) throw new Error("auth info did not report authRequired=true");

      // Unauthenticated request is rejected.
      const unauthRes = await fetch(`http://${authHandle.hostname}:${authHandle.port}/api/chat/state`);
      if (unauthRes.status !== 401) throw new Error(`unauthenticated state HTTP ${unauthRes.status}`);

      // Wrong token is rejected.
      const wrongRes = await fetch(`http://${authHandle.hostname}:${authHandle.port}/api/chat/state`, {
        headers: { authorization: "Bearer " + "wrong" },
      });
      if (wrongRes.status !== 401) throw new Error(`wrong-token state HTTP ${wrongRes.status}`);

      // Correct token is accepted.
      const okRes = await fetch(`http://${authHandle.hostname}:${authHandle.port}/api/chat/state`, {
        headers: { authorization: "Bearer " + "smoke-secret-token" },
      });
      if (okRes.status !== 200) throw new Error(`authenticated state HTTP ${okRes.status}`);
    } finally {
      await authServer.close();
    }
    console.log("gateway auth token gate round trip: ok");

    // No-token localhost server does not enforce auth.
    const openServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
    });
    try {
      const openHandle = await openServer.start();
      const openInfo = await fetch(`http://${openHandle.hostname}:${openHandle.port}/api/auth/info`);
      const openInfoBody = (await openInfo.json()) as { authRequired: boolean };
      if (openInfoBody.authRequired) throw new Error("open server reported authRequired=true");
      const openState = await fetch(`http://${openHandle.hostname}:${openHandle.port}/api/chat/state`);
      if (openState.status !== 200) throw new Error(`open state HTTP ${openState.status}`);
    } finally {
      await openServer.close();
    }
    console.log("gateway no-token localhost open access: ok");

    // Phase 3 frontend: static file serving. The gateway serves index.html
    // at GET / and other static assets by relative path with MIME detection.
    // API routes take priority over static files.
    const staticServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
      publicDir: join(process.cwd(), "public"),
    });
    try {
      const staticHandle = await staticServer.start();

      // GET / serves index.html
      const indexRes = await fetch(`http://${staticHandle.hostname}:${staticHandle.port}/`);
      if (indexRes.status !== 200) throw new Error(`index HTTP ${indexRes.status}`);
      if (!indexRes.headers.get("content-type")?.includes("text/html")) {
        throw new Error("index did not return text/html");
      }
      const indexBody = await indexRes.text();
      if (!indexBody.includes("Piren Gateway")) throw new Error("index.html did not contain expected title");

      // GET /app.js serves JavaScript
      const jsRes = await fetch(`http://${staticHandle.hostname}:${staticHandle.port}/app.js`);
      if (jsRes.status !== 200) throw new Error(`app.js HTTP ${jsRes.status}`);
      if (!jsRes.headers.get("content-type")?.includes("javascript")) {
        throw new Error("app.js did not return javascript content-type");
      }

      // API routes still take priority over static files
      const apiRes = await fetch(`http://${staticHandle.hostname}:${staticHandle.port}/api/auth/info`);
      if (apiRes.status !== 200) throw new Error(`api over static HTTP ${apiRes.status}`);
    } finally {
      await staticServer.close();
    }
    console.log("gateway static file serving: ok");

    // Phase 3 tracer bullet 8: session resume and abort. The RPC client gained
    // abort/getMessages/switchSession; the gateway exposes them as POST
    // /api/chat/abort, GET /api/chat/messages, POST /api/chat/resume, and
    // GET /api/chat/sessions (vault summaries for the current agent).
    const sessionVault = join(fixture.root, "session-vault");
    await mkdir(join(sessionVault, "team", "thor", "sessions"), { recursive: true });
    await writeFile(
      join(sessionVault, "team", "thor", "sessions", "20260623T090000Z-smoke.md"),
      [
        "---",
        "type: session-summary",
        "agent: thor",
        "created: 2026-06-23T09:00:00.000Z",
        "---",
        "",
        "# Smoke Session",
        "",
        "Session resume smoke.",
      ].join("\n"),
    );
    const sessionServer = new GatewayServer({
      target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
      vaultRoot: sessionVault,
      runnableAgents: ["thor"],
      initialAgent: "thor",
    });
    let sessionHandle;
    try {
      sessionHandle = await sessionServer.start();

      // GET /api/chat/sessions lists vault summaries for the current agent.
      const sessionsRes = await fetch(`http://${sessionHandle.hostname}:${sessionHandle.port}/api/chat/sessions`);
      if (sessionsRes.status !== 200) throw new Error(`sessions HTTP ${sessionsRes.status}`);
      const sessionsBody = (await sessionsRes.json()) as { agent: string; sessions: Array<{ name: string }> };
      if (sessionsBody.agent !== "thor" || sessionsBody.sessions.length === 0) {
        throw new Error(`sessions body mismatch: ${JSON.stringify(sessionsBody)}`);
      }

      // GET /api/chat/messages returns the current transcript.
      const messagesRes = await fetch(`http://${sessionHandle.hostname}:${sessionHandle.port}/api/chat/messages`);
      if (messagesRes.status !== 200) throw new Error(`messages HTTP ${messagesRes.status}`);
      const messagesBody = (await messagesRes.json()) as { messages: unknown[] };
      if (!Array.isArray(messagesBody.messages) || messagesBody.messages.length === 0) {
        throw new Error("messages list is empty");
      }

      // POST /api/chat/resume resumes a session and reports cancelled=false.
      const resumeRes = await fetch(`http://${sessionHandle.hostname}:${sessionHandle.port}/api/chat/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionPath: "/fake/session.jsonl" }),
      });
      if (resumeRes.status !== 200) throw new Error(`resume HTTP ${resumeRes.status}`);
      const resumeBody = (await resumeRes.json()) as { cancelled: boolean };
      if (resumeBody.cancelled) throw new Error("resume reported cancelled unexpectedly");

      // POST /api/chat/abort aborts the active turn. Start one first.
      const abortStartRes = await fetch(`http://${sessionHandle.hostname}:${sessionHandle.port}/api/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });
      if (abortStartRes.status !== 200) throw new Error(`abort-start HTTP ${abortStartRes.status}`);
      const abortRes = await fetch(`http://${sessionHandle.hostname}:${sessionHandle.port}/api/chat/abort`, {
        method: "POST",
      });
      if (abortRes.status !== 200) throw new Error(`abort HTTP ${abortRes.status}`);

      // Missing sessionPath is rejected.
      const badResumeRes = await fetch(`http://${sessionHandle.hostname}:${sessionHandle.port}/api/chat/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (badResumeRes.status !== 400) throw new Error(`bad resume HTTP ${badResumeRes.status}`);
    } finally {
      await sessionServer.close();
    }
    console.log("gateway session resume+abort round trip: ok");

    console.log("SMOKE PASSED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

await main();
