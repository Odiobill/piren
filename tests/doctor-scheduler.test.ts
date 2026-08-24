import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSchedulerAutomationConfig, doctorPiren, type DoctorCheck, type PiRuntimeCheck } from "../src/doctor.js";
import type { LocalPirenConfig } from "../src/bootstrap.js";
import { initVault } from "../src/init.js";

const SCHEDULER_AUTHORITY =
  "Authority: scheduler automation is machine-local local-config authority and doctor is read-only; Piren will not infer intent.";

// SGC-3 (contract §4.3): exact legacy-gate guidance pins.
const GATED_WARN =
  "scheduler.enabled is present as a retired legacy gate; all automation classes resolve disabled (fail closed) " +
  "until an operator-confirmed piren scheduler configure migration removes the retired key. " +
  `${SCHEDULER_AUTHORITY} Next: inspect scheduler.enabled in ~/.config/piren/config.yml.`;

function gatedOk(inbox: boolean, agent: boolean, script: boolean): string {
  return `scheduler: inbox_tasks: ${inbox}; agent_cron: ${agent}; script_cron: ${script}.`;
}

function ignoredOk(inbox: boolean, agent: boolean, script: boolean): string {
  return (
    gatedOk(inbox, agent, script) +
    " Retired key scheduler.enabled is present with an inert true value; automation classes are the sole gates."
  );
}

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
  it("reports ok with bounded class state; an explicit enabled:true is inert-to-ignore", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: {
        enabled: true,
        automation: { inbox_tasks: true, agent_cron: true, script_cron: true },
      },
    });
    expect(check?.status).toBe("ok");
    expect(check?.id).toBe("scheduler");
    expect(check?.message).toBe(ignoredOk(true, true, true));
  });

  it("reports a fresh/empty present block with all classes false and no master-gate language", () => {
    const check = checkSchedulerAutomationConfig({ scheduler: {} });
    expect(check?.status).toBe("ok");
    expect(check?.message).toBe(gatedOk(false, false, false));
  });

  it("reports an established legacy block (shape B) from its automation declaration alone", () => {
    const check = checkSchedulerAutomationConfig({ scheduler: { poll_interval_seconds: 15 } });
    expect(check?.status).toBe("ok");
    expect(check?.message).toBe(gatedOk(false, false, false));
    // Shape B needs no migration action.
    expect(check?.message).not.toMatch(/[Ll]egacy|migration|configure/i);
  });

  it("reports a partial automation block with the missing classes false", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: { automation: { inbox_tasks: true } },
    });
    expect(check?.status).toBe("ok");
    expect(check?.message).toBe(gatedOk(true, false, false));
  });

  it("treats a null class value as absent-like but a null enabled key as gated (SGC-3 correction)", () => {
    const check = checkSchedulerAutomationConfig({
      scheduler: {
        enabled: null as unknown as boolean,
        automation: { inbox_tasks: null as unknown as boolean },
      },
    });
    // The retired key gates; the null class value is merely absent-like.
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe(GATED_WARN);
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
      "scheduler config is present but is not a mapping; all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler in ~/.config/piren/config.yml.`,
    );
    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: ["enabled"] } as unknown as LocalPirenConfig),
      "scheduler config is present but is not a mapping; all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler in ~/.config/piren/config.yml.`,
    );
  });

  it("warns on a non-boolean enabled (gated legacy shape E) without echoing the value", () => {
    const message = expectWarn(
      checkSchedulerAutomationConfig({ scheduler: { enabled: "yes" } } as unknown as LocalPirenConfig),
      GATED_WARN,
    );
    expect(message).not.toContain("yes");

    expectWarn(
      checkSchedulerAutomationConfig({ scheduler: { enabled: 1 } } as unknown as LocalPirenConfig),
      GATED_WARN,
    );
  });

  it("warns on an explicit enabled:null legacy gate (present-but-empty retired value) with the exact SGC-3 guidance", () => {
    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { enabled: null as unknown as boolean, automation: { inbox_tasks: true } },
      } as unknown as LocalPirenConfig),
      GATED_WARN,
    );
  });

  it("warns on an explicit enabled:false legacy gate (shape D) with the exact SGC-3 guidance", () => {
    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { enabled: false, automation: { inbox_tasks: true, agent_cron: true } },
      }),
      GATED_WARN,
    );
    // Even a vacuous gate stays consistent fail-closed (shape F).
    expectWarn(checkSchedulerAutomationConfig({ scheduler: { enabled: false } }), GATED_WARN);
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
    // Known class beats the retired gate.
    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { enabled: "yes", automation: { inbox_tasks: 1 } },
      } as unknown as LocalPirenConfig),
      "scheduler.automation.inbox_tasks is present but is not a boolean; inbox task automation resolves disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation.inbox_tasks in ~/.config/piren/config.yml.`,
    );
    // Automation container beats the retired gate (deterministic ordering).
    expectWarn(
      checkSchedulerAutomationConfig({
        scheduler: { enabled: "yes", automation: "on" },
      } as unknown as LocalPirenConfig),
      "scheduler.automation is present but is not a mapping; all automation classes resolve disabled (fail closed). " +
        `${SCHEDULER_AUTHORITY} Next: inspect scheduler.automation in ~/.config/piren/config.yml.`,
    );
  });

  it("never emits raw values, tokens, or service/mutation instructions in malformed-value warns", () => {
    const cases: LocalPirenConfig[] = [
      { scheduler: "yes" } as unknown as LocalPirenConfig,
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

  it("the gated-legacy warn names the sole migration writer but never echoes values or quotes", () => {
    for (const config of [
      { scheduler: { enabled: false } },
      { scheduler: { enabled: "junk" } } as unknown as LocalPirenConfig,
    ]) {
      const check = checkSchedulerAutomationConfig(config as unknown as LocalPirenConfig);
      expect(check?.status).toBe("warn");
      const message = check?.message ?? "";
      expect(message).toBe(GATED_WARN);
      expect(message).toContain("piren scheduler configure");
      expect(message).not.toMatch(/["']/);
      expect(message).not.toContain("junk");
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
        message: ignoredOk(true, false, false),
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
      expect.objectContaining({ id: "scheduler", status: "warn", message: GATED_WARN }),
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
    expect(schedulerCheck?.message).toBe(GATED_WARN);
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
