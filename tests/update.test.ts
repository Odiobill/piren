import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPDATE_SPEC,
  buildUpdateCommand,
  executePirenUpdate,
  formatRunPirenUpdate,
  formatUpdateReport,
  parseSemver,
  planUpdate,
  resolveRegistryVersion,
  runPirenUpdate,
  type CommandResult,
  type ExecuteUpdateDeps,
} from "../src/update.js";

/** Build a fake deps object that records calls and returns scripted responses. */
function makeDeps(
  responses: Array<{ match: (command: string, args: string[]) => boolean; result: CommandResult }>,
): ExecuteUpdateDeps & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runCommand = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push({ command, args });
    const r = responses.find((entry) => entry.match(command, args));
    if (!r) throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    return r.result;
  };
  return { runCommand, calls };
}

const isView = (spec: string) => (_c: string, a: string[]) => a[0] === "view" && a[1] === spec && a[2] === "version";
const isInstall = (spec: string) => (c: string, a: string[]) =>
  c === "npm" && a[0] === "install" && a[1] === "-g" && a[2] === spec;

describe("buildUpdateCommand", () => {
  it("defaults to the scoped registry latest package with no --install-links", () => {
    const command = buildUpdateCommand();
    expect(command.command).toBe("npm");
    expect(command.args).toEqual(["install", "-g", DEFAULT_UPDATE_SPEC]);
    expect(DEFAULT_UPDATE_SPEC).toBe("@odiobill/piren");
    expect(command.args).not.toContain("--install-links");
    expect(command.args).not.toContain(expect.stringContaining("github:"));
  });

  it("accepts an explicit spec override", () => {
    const command = buildUpdateCommand("@odiobill/piren@0.1.4");
    expect(command.args).toEqual(["install", "-g", "@odiobill/piren@0.1.4"]);
  });
});

describe("parseSemver (strict, no dependency)", () => {
  it("parses a normal release", () => {
    expect(parseSemver("0.1.3")).toEqual({ major: 0, minor: 1, patch: 3, prerelease: "", build: "" });
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "", build: "" });
    expect(parseSemver("10.20.30")?.major).toBe(10);
  });

  it("parses a valid prerelease and build suffix", () => {
    const v = parseSemver("1.2.3-rc.1+build.5");
    expect(v).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "rc.1", build: "build.5" });
    expect(parseSemver("1.0.0-alpha")?.prerelease).toBe("alpha");
    expect(parseSemver("1.0.0+exp.sha.5114f85")?.build).toBe("exp.sha.5114f85");
  });

  it("rejects malformed versions", () => {
    const bad = ["unknown", "1", "1.2", "v1.2.3", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "", " 1.2.3", "1.2.3 ", "1.2.3-01", "abc.def.ghi"];
    for (const version of bad) {
      expect(parseSemver(version), `expected null for ${JSON.stringify(version)}`).toBeNull();
    }
  });
});

describe("planUpdate", () => {
  const install = (c: string, t: string) =>
    planUpdate({ currentVersion: c, targetVersion: t, allowMajor: false });

  it("installs for same / minor / patch updates", () => {
    expect(install("0.1.3", "0.1.3").action).toBe("install");
    expect(install("0.1.3", "0.1.4").action).toBe("install");
    expect(install("0.1.3", "0.2.0").action).toBe("install");
  });

  it("installs a same-major prerelease target", () => {
    expect(install("0.1.3", "0.2.0-rc.1").action).toBe("install");
  });

  it("refuses a major-version jump without --yes", () => {
    const plan = install("0.1.3", "1.0.0");
    expect(plan.action).toBe("refuse-major");
    if (plan.action === "refuse-major") {
      expect(plan.currentVersion).toBe("0.1.3");
      expect(plan.targetVersion).toBe("1.0.0");
      // The command it WOULD run is still the registry spec (no --install-links).
      expect(plan.command.args).toEqual(["install", "-g", "@odiobill/piren"]);
    }
  });

  it("refuses a major jump even when the target is a prerelease of a higher major", () => {
    expect(install("0.1.3", "1.0.0-rc.1").action).toBe("refuse-major");
  });

  it("allows a major-version jump with --yes", () => {
    const plan = planUpdate({ currentVersion: "0.1.3", targetVersion: "1.0.0", allowMajor: true });
    expect(plan.action).toBe("install");
  });

  it("rejects a malformed current version before any install", () => {
    const plan = planUpdate({ currentVersion: "unknown", targetVersion: "0.1.4", allowMajor: false });
    expect(plan.action).toBe("version-error");
    if (plan.action === "version-error") {
      expect(plan.field).toBe("current");
      expect(plan.version).toBe("unknown");
    }
  });

  it("rejects a malformed target version", () => {
    const plan = planUpdate({ currentVersion: "0.1.3", targetVersion: "garbage", allowMajor: false });
    expect(plan.action).toBe("version-error");
    if (plan.action === "version-error") expect(plan.field).toBe("target");
  });
});

describe("resolveRegistryVersion", () => {
  it("parses the version from npm view <spec> version", async () => {
    const deps = makeDeps([
      {
        match: isView("@odiobill/piren"),
        result: { exitCode: 0, stdout: "0.1.4\n", stderr: "" },
      },
    ]);
    const result = await resolveRegistryVersion(deps);
    expect(result).toEqual({ ok: true, version: "0.1.4" });
    expect(deps.calls).toEqual([{ command: "npm", args: ["view", "@odiobill/piren", "version"] }]);
  });

  it("fails closed on a non-zero exit", async () => {
    const deps = makeDeps([
      {
        match: isView("@odiobill/piren"),
        result: { exitCode: 1, stdout: "", stderr: "E404 Not Found" },
      },
    ]);
    const result = await resolveRegistryVersion(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("failed");
  });

  it("fails closed on empty output", async () => {
    const deps = makeDeps([
      {
        match: isView("@odiobill/piren"),
        result: { exitCode: 0, stdout: "   \n", stderr: "" },
      },
    ]);
    const result = await resolveRegistryVersion(deps);
    expect(result.ok).toBe(false);
  });
});

describe("runPirenUpdate", () => {
  it("resolves, plans, and installs for a same-major update", async () => {
    const deps = makeDeps([
      { match: isView("@odiobill/piren"), result: { exitCode: 0, stdout: "0.1.4\n", stderr: "" } },
      { match: isInstall("@odiobill/piren"), result: { exitCode: 0, stdout: "added\n", stderr: "" } },
    ]);
    const outcome = await runPirenUpdate(deps, { currentVersion: "0.1.3", allowMajor: false });
    expect(outcome.kind).toBe("installed");
    if (outcome.kind === "installed") expect(outcome.report.ok).toBe(true);
    // install was actually invoked
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(true);
  });

  it("reports a failed npm install", async () => {
    const deps = makeDeps([
      { match: isView("@odiobill/piren"), result: { exitCode: 0, stdout: "0.1.4\n", stderr: "" } },
      { match: isInstall("@odiobill/piren"), result: { exitCode: 1, stdout: "", stderr: "permission denied" } },
    ]);
    const outcome = await runPirenUpdate(deps, { currentVersion: "0.1.3", allowMajor: false });
    expect(outcome.kind).toBe("installed");
    if (outcome.kind === "installed") expect(outcome.report.ok).toBe(false);
  });

  it("refuses a major jump without --yes and performs no install", async () => {
    const deps = makeDeps([
      { match: isView("@odiobill/piren"), result: { exitCode: 0, stdout: "1.0.0\n", stderr: "" } },
      { match: isInstall("@odiobill/piren"), result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const outcome = await runPirenUpdate(deps, { currentVersion: "0.1.3", allowMajor: false });
    expect(outcome.kind).toBe("refused-major");
    if (outcome.kind === "refused-major") {
      expect(outcome.targetVersion).toBe("1.0.0");
      expect(outcome.command.args).toEqual(["install", "-g", "@odiobill/piren"]);
    }
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  it("permits a major jump with --yes and installs", async () => {
    const deps = makeDeps([
      { match: isView("@odiobill/piren"), result: { exitCode: 0, stdout: "1.0.0\n", stderr: "" } },
      { match: isInstall("@odiobill/piren"), result: { exitCode: 0, stdout: "added\n", stderr: "" } },
    ]);
    const outcome = await runPirenUpdate(deps, { currentVersion: "0.1.3", allowMajor: true });
    expect(outcome.kind).toBe("installed");
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(true);
  });

  it("aborts on resolver failure and performs no install", async () => {
    const deps = makeDeps([
      { match: isView("@odiobill/piren"), result: { exitCode: 1, stdout: "", stderr: "offline" } },
      { match: isInstall("@odiobill/piren"), result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const outcome = await runPirenUpdate(deps, { currentVersion: "0.1.3", allowMajor: false });
    expect(outcome.kind).toBe("resolver-error");
    if (outcome.kind === "resolver-error") expect(outcome.reason).toContain("failed");
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  it("aborts on a malformed current version before resolving or installing", async () => {
    const deps = makeDeps([
      { match: isView("@odiobill/piren"), result: { exitCode: 0, stdout: "0.1.4\n", stderr: "" } },
      { match: isInstall("@odiobill/piren"), result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const outcome = await runPirenUpdate(deps, { currentVersion: "unknown", allowMajor: false });
    expect(outcome.kind).toBe("version-error");
    if (outcome.kind === "version-error") {
      expect(outcome.field).toBe("current");
      expect(outcome.version).toBe("unknown");
    }
    // Fail fast: no network resolve and no install attempted.
    expect(deps.calls.some((c) => c.args[0] === "view")).toBe(false);
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(false);
  });
});

describe("executePirenUpdate and formatUpdateReport", () => {
  it("runs the registry install command through injected deps", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const report = await executePirenUpdate({
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "added\n", stderr: "" };
      },
    });
    expect(calls).toEqual([{ command: "npm", args: ["install", "-g", "@odiobill/piren"] }]);
    expect(report.ok).toBe(true);
    expect(report.args).toEqual(["install", "-g", "@odiobill/piren"]);
  });

  it("formats success and failure reports with the registry command", () => {
    const okText = formatUpdateReport({
      ok: true,
      command: "npm",
      args: ["install", "-g", "@odiobill/piren"],
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    });
    expect(okText).toContain("Piren update: ok");
    expect(okText).toContain("npm install -g @odiobill/piren");
    expect(okText).not.toContain("--install-links");
    expect(okText).not.toContain("github:");

    const failText = formatUpdateReport({
      ok: false,
      command: "npm",
      args: ["install"],
      exitCode: 1,
      stdout: "",
      stderr: "permission denied\n",
    });
    expect(failText).toContain("Piren update: failed");
    expect(failText).toContain("permission denied");
  });
});

describe("formatRunPirenUpdate", () => {
  it("delegates installed reports to formatUpdateReport", () => {
    const text = formatRunPirenUpdate({
      kind: "installed",
      report: {
        ok: true,
        command: "npm",
        args: ["install", "-g", "@odiobill/piren"],
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
    });
    expect(text).toContain("Piren update: ok");
  });

  it("tells the user the target version and the exact --yes opt-in on refusal", () => {
    const text = formatRunPirenUpdate({
      kind: "refused-major",
      currentVersion: "0.1.3",
      targetVersion: "1.0.0",
      command: { command: "npm", args: ["install", "-g", "@odiobill/piren"] },
    });
    expect(text).toContain("1.0.0");
    expect(text).toContain("piren update --yes");
    expect(text).toContain("No changes were made.");
  });

  it("reports a malformed version without installing", () => {
    const text = formatRunPirenUpdate({ kind: "version-error", field: "current", version: "unknown" });
    expect(text).toContain("unknown");
    expect(text).toContain("No changes were made.");
  });

  it("reports a resolver failure without installing", () => {
    const text = formatRunPirenUpdate({ kind: "resolver-error", reason: "npm view exited 1" });
    expect(text).toContain("Could not resolve");
    expect(text).toContain("No changes were made.");
  });
});
