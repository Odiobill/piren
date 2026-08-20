import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSchedulerAutomationConfig, doctorPiren, type DoctorCheck, type PiRuntimeCheck } from "../src/doctor.js";
import type { LocalPirenConfig } from "../src/bootstrap.js";
import { initVault } from "../src/init.js";

const SCHEDULER_AUTHORITY =
  "Authority: scheduler automation is machine-local local-config authority and doctor is read-only; Piren will not infer intent.";

function expectWarn(check: DoctorCheck | null, expected: string): string {
  expect(check).not.toBeNull();
  expect(check?.status).toBe("warn");
  expect(check?.message).toBe(expected);
  return check?.message ?? "";
}

// ---------------------------------------------------------------------------
// checkSchedulerAutomationConfig: present-only omission
// ---------------------------------------------------------------------------

describe("checkSchedulerAutomationConfig: present-only omission", () => {
  it("returns null when no scheduler block is present (normal doctor unchanged)", () => {
    expect(checkSchedulerAutomationConfig({})).toBeNull();
  });

  it("returns null when scheduler is null (bare `scheduler:` is absent-like)", () => {
    expect(
      checkSchedulerAutomationConfig({ scheduler: null } as unknown as LocalPirenConfig),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkSchedulerAutomationConfig: valid present blocks (ok)
// ---------------------------------------------------------------------------

describe("checkSchedulerAutomationConfig: valid present blocks (ok)", () => {
  it("reports ok with bounded resolved master/class state for an explicit valid block", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: {
        enabled: true,
        automation: { inbox_tasks: true, agent_cron: true, script_cron: true },
      },
    });
    expect(check).not.toBeNull();
    expect(check?.status).toBe("ok");
    expect(check?.id).toBe("scheduler");
    expect(check?.message).toContain("enabled: true");
    expect(check?.message).toContain("inbox_tasks: true");
    expect(check?.message).toContain("agent_cron: true");
    expect(check?.message).toContain("script_cron: true");
  });

  it("reports fresh/empty present block as enabled false with all classes false", () => {
    const check = checkSchedulerAutomationConfig({ scheduler: {} });
    expect(check?.status).toBe("ok");
    expect(check?.message).toBe(
      "scheduler: enabled: false; inbox_tasks: false; agent_cron: false; script_cron: false.",
    );
  });

  it("reports a legacy established block with enabled true and read-only migration status", () => {
    const check = checkSchedulerAutomationConfig({ scheduler: { poll_interval_seconds: 15 } });
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("enabled: true");
    expect(check?.message).toMatch(/[Ll]egacy/);
    expect(check?.message).toContain("read-only");
    // Never claims a write happened or instructs one.
    expect(check?.message).not.toMatch(/wrote|persist(ed|s)? now|run piren|piren scheduler/i);
  });

  it("reports an explicit enabled: false as ok (declared intent, inspectable)", () => {
    const check = checkSchedulerAutomationConfig({ scheduler: { enabled: false } });
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("enabled: false");
  });

  it("reports a partial automation block with the missing classes false", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: { enabled: true, automation: { inbox_tasks: true } },
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("inbox_tasks: true");
    expect(check?.message).toContain("agent_cron: false");
    expect(check?.message).toContain("script_cron: false");
  });

  it("treats null values as absent-like (fail closed, still ok)", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: {
        enabled: null as unknown as boolean,
        automation: { inbox_tasks: null as unknown as boolean },
      },
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("enabled: false");
    expect(check?.message).toContain("inbox_tasks: false");
  });

  it("does not warn for unknown automation keys and never echoes their names", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: {
        automation: { polling_enabled: true } as unknown as { inbox_tasks?: boolean },
      },
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).not.toContain("polling_enabled");
  });
});

// ---------------------------------------------------------------------------
// checkSchedulerAutomationConfig: malformed WARN with exact E2-S2 guidance
// ---------------------------------------------------------------------------

describe("checkSchedulerAutomationConfig: malformed WARN with exact E2-S2 guidance", () => {
  it("warns on a non-mapping scheduler block, targeting the scheduler block itself", () => {
    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: "yes" } as unknown as LocalPirenConfig),
      "scheduler config is present but is not a mapping; the scheduler and all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler in ~/.config/piren/config.yml.`,
    );
    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: ["enabled"] } as unknown as LocalPirenConfig),
      "scheduler config is present but is not a mapping; the scheduler and all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler in ~/.config/piren/config.yml.`,
    );
  });

  it("warns on a non-boolean enabled, targeting scheduler.enabled, without echoing the value", () => {
    const message = expectWarn(
      checkSchedulerAutomationConfig({ scheduler: { enabled: "yes" } } as unknown as LocalPirenConfig),
      "scheduler.enabled is present but is not a boolean; the scheduler resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.enabled in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("yes");

    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: { enabled: 1 } } as unknown as LocalPirenConfig),
      "scheduler.enabled is present but is not a boolean; the scheduler resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.enabled in ~/.config/piren/config.yml.`,
    );
  });

  it("warns on a non-mapping automation container, targeting scheduler.automation", () => {
    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: { automation: "on" } } as unknown as LocalPirenConfig),
      "scheduler.automation is present but is not a mapping; all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation in ~/.config/piren/config.yml.`,
    );
    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: { automation: [true] } } as unknown as LocalPirenConfig),
      "scheduler.automation is present but is not a mapping; all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation in ~/.config/piren/config.yml.`,
    );
  });

  it("warns on a non-boolean known class value, targeting that class, without echoing the value", () => {
    const message = expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { automation: { inbox_tasks: "yes" } },
      } as unknown as LocalPirenConfig),
      "scheduler.automation.inbox_tasks is present but is not a boolean; inbox task automation resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation.inbox_tasks in ~/.config/piren/config.yml.`,
    );
    expect(message).not.toContain("yes");

    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { automation: { agent_cron: 1 } },
      } as unknown as LocalPirenConfig),
      "scheduler.automation.agent_cron is present but is not a boolean; agent cron automation resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation.agent_cron in ~/.config/piren/config.yml.`,
    );
  });

  it("selects the narrowest relevant target when multiple categories are malformed", () => {
    // Known class beats enabled.
    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { enabled: "yes", automation: { inbox_tasks: 1 } },
      } as unknown as LocalPirenConfig),
      "scheduler.automation.inbox_tasks is present but is not a boolean; inbox task automation resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation.inbox_tasks in ~/.config/piren/config.yml.`,
    );
    // Automation container beats enabled (deterministic ordering).
    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { enabled: "yes", automation: "on" },
      } as unknown as LocalPirenConfig),
      "scheduler.automation is present but is not a mapping; all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation in ~/.config/piren/config.yml.`,
    );
  });

  it("never emits raw values, tokens, or service/mutation instructions in any warn", () => {
    const cases: LocalPirenConfig[] = [
      { scheduler: "yes" } as unknown as LocalPirenConfig,
      { scheduler: { enabled: "yes" } } as unknown as LocalPirenConfig,
      { scheduler: { enabled: 1 } } as unknown as LocalPirenConfig,
      { scheduler: { automation: "on" } } as unknown as LocalPirenConfig,
      { scheduler: { automation: { inbox_tasks: "yes" } } } as unknown as LocalPirenConfig,
      { scheduler: { automation: { script_cron: 42 } } } as unknown as LocalPirenConfig,
    ];
    for (const config of cases) {
      const check = checkSchedulerAutomationConfig(config);
      expect(check).not.toBeNull();
      expect(check?.status).toBe("warn");
      const message = check?.message ?? "";
      expect(message).not.toMatch(/["']/);
      expect(message).not.toMatch(/\b(yes|on|42)\b/);
      expect(message).not.toMatch(/run piren|piren scheduler|install|start service|configure|write|persist/i);
    }
  });
});

// ---------------------------------------------------------------------------
// doctorPiren wiring: both flows, read-only, existing checks unchanged
// ---------------------------------------------------------------------------

const localPiRuntime = async (): Promise<PiRuntimeCheck> => ({ source: "path", version: "0.80.2" });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-doctor-scheduler-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("doctorPiren: scheduler check wiring", () => {
  it("includes the scheduler check in the normal selected-agent flow when a scheduler block is present", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(
      configPath,
      "vault_root: " + root + "\nallowed_agents:\n  - thor\nscheduler:\n  enabled: true\n  automation:\n    inbox_tasks: true\n",
    );

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "scheduler",
        status: "ok",
        message: "scheduler: enabled: true; inbox_tasks: true; agent_cron: false; script_cron: false.",
      }),
    ]));
  });

  it("includes the scheduler check in the all-runnable-agent flow when a scheduler block is present", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    await initVault({ vaultRoot: root, agentName: "heimdall", force: true });
    const configPath = join(root, "config.yml");
    await writeFile(
      configPath,
      "vault_root: " + root + "\nallowed_agents:\n  - thor\n  - heimdall\nscheduler:\n  enabled: false\n",
    );

    const report = await doctorPiren({ env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scheduler", status: "ok", message: expect.stringContaining("enabled: false") }),
    ]));
  });

  it("omits the scheduler check entirely when no scheduler block is declared (normal doctor unchanged)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(configPath, "vault_root: " + root + "\nallowed_agents:\n  - thor\n");

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks.some((check) => check.id === "scheduler")).toBe(false);
  });

  it("surfaces a malformed scheduler block as a warn check and leaves the config file byte-identical (read-only)", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    const configText =
      "vault_root: " + root + "\nallowed_agents:\n  - thor\nscheduler:\n  enabled: \"yes\"\n";
    await writeFile(configPath, configText);

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    const schedulerCheck = report.checks.find((check) => check.id === "scheduler");
    expect(schedulerCheck).toBeDefined();
    expect(schedulerCheck?.status).toBe("warn");
    expect(schedulerCheck?.message).toBe(
      "scheduler.enabled is present but is not a boolean; the scheduler resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.enabled in ~/.config/piren/config.yml.`,
    );
    // Read-only: the exact config text is unchanged (no migration/write).
    expect(await readFile(configPath, "utf8")).toBe(configText);
  });

  it("preserves existing check messages byte-for-byte alongside the new scheduler check", async () => {
    await initVault({ vaultRoot: root, agentName: "thor" });
    const configPath = join(root, "config.yml");
    await writeFile(
      configPath,
      "vault_root: " + root + "\nallowed_agents:\n  - thor\ntelegram:\n  bot_token: T\nscheduler:\n  enabled: true\n",
    );

    const report = await doctorPiren({ cliAgent: "thor", env: {}, configPath, piRuntimeChecker: localPiRuntime });

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "telegram",
        status: "warn",
        message: "telegram.bot_token is set but telegram.allowed_chat_ids is empty. No chats are authorized. " +
          "Authority: transport credentials and routing live only in local config and are not inferable from the vault. " +
          "Next: inspect telegram.allowed_chat_ids in ~/.config/piren/config.yml.",
      }),
      expect.objectContaining({ id: "scheduler", status: "ok" }),
    ]));
  });
});
