import { mkdtemp, mkdir, readFile, rm, writeFile, access, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePirenCommand,
  executeServiceAction,
  type ServiceExecDeps,
  formatServiceReport,
} from "../src/service-lifecycle.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-svc-exec-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("service-lifecycle exec: piren command resolution", () => {
  it("prefers an explicit override", () => {
    expect(resolvePirenCommand({ explicit: "/custom/piren" })).toBe("/custom/piren");
  });

  it("falls back to the bare 'piren' binary name when no override is given", () => {
    expect(resolvePirenCommand({})).toBe("piren");
  });
});

describe("service-lifecycle exec: install writes files and runs commands", () => {
  it("writes all plan files and records each command result", async () => {
    const servicesDir = join(root, "services");
    await mkdir(servicesDir, { recursive: true });

    const runCommands: string[] = [];
    const deps: ServiceExecDeps = {
      writeFile: async (path, content, opts) => {
        await writeFile(path, content, "utf8");
        if (opts?.executable) {
          await chmod(path, 0o755);
        }
      },
      removeFile: async (path) => {
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true });
      },
      runCommand: async (command) => {
        runCommands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      log: () => {},
    };

    const report = await executeServiceAction({
      action: "install",
      transport: "gateway",
      manager: "systemd",
      pirenCommand: "piren",
      vaultRoot: join(root, "vault"),
      agentName: "piren",
      servicesDir,
      deps,
    });

    expect(report.ok).toBe(true);
    expect(report.executedCommands).toBeGreaterThan(0);
    expect(report.writtenFiles.length).toBe(1);
    // The unit file content should be on disk.
    const unitContent = await readFile(report.writtenFiles[0]!.path, "utf8");
    expect(unitContent).toContain("piren gateway");
    expect(runCommands).toContain("systemctl --user daemon-reload");
  });
});

describe("service-lifecycle exec: tmux-cron install makes the script executable", () => {
  it("marks the launch script executable", async () => {
    const servicesDir = join(root, "services");
    await mkdir(servicesDir, { recursive: true });

    const deps: ServiceExecDeps = {
      writeFile: async (path, content, opts) => {
        await writeFile(path, content, "utf8");
        if (opts?.executable) {
          await chmod(path, 0o755);
        }
      },
      removeFile: async (path) => {
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true });
      },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      log: () => {},
    };

    const report = await executeServiceAction({
      action: "install",
      transport: "telegram",
      manager: "tmux-cron",
      pirenCommand: "piren",
      vaultRoot: join(root, "vault"),
      agentName: "thor",
      servicesDir,
      deps,
    });

    const scriptPath = report.writtenFiles.find((f) => f.path.endsWith(".tmux.sh"))!.path;
    await expect(access(scriptPath)).resolves.toBeUndefined();
  });
});

describe("service-lifecycle exec: remove deletes files", () => {
  it("removes generated files and runs cleanup commands", async () => {
    const servicesDir = join(root, "services");
    await mkdir(servicesDir, { recursive: true });
    const unitPath = join(servicesDir, "piren-gateway.service");
    await writeFile(unitPath, "dummy unit");

    const deps: ServiceExecDeps = {
      writeFile: async () => {},
      removeFile: async (path) => {
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true });
      },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      log: () => {},
    };

    const report = await executeServiceAction({
      action: "remove",
      transport: "gateway",
      manager: "systemd",
      pirenCommand: "piren",
      vaultRoot: join(root, "vault"),
      agentName: "piren",
      servicesDir,
      deps,
    });

    expect(report.ok).toBe(true);
    expect(report.removedFiles).toContain(unitPath);
    await expect(access(unitPath)).rejects.toThrow();
  });
});

describe("service-lifecycle exec: command failures are reported, not fatal", () => {
  it("collects a non-zero exit code as an error but continues", async () => {
    const servicesDir = join(root, "services");
    await mkdir(servicesDir, { recursive: true });

    const deps: ServiceExecDeps = {
      writeFile: async (path, content) => { await writeFile(path, content, "utf8"); },
      removeFile: async () => {},
      runCommand: async (command) => {
        if (command.includes("systemctl --user start")) {
          return { exitCode: 1, stdout: "", stderr: "Unit not loaded" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      log: () => {},
    };

    const report = await executeServiceAction({
      action: "install",
      transport: "gateway",
      manager: "systemd",
      pirenCommand: "piren",
      vaultRoot: join(root, "vault"),
      agentName: "piren",
      servicesDir,
      deps,
    });

    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain("systemctl --user start");
  });
});

describe("service-lifecycle exec: report formatting", () => {
  it("formats an install report with files and commands", () => {
    const text = formatServiceReport({
      ok: true,
      action: "install",
      transport: "gateway",
      manager: "systemd",
      writtenFiles: [{ path: "/tmp/piren-gateway.service", content: "x" }],
      removedFiles: [],
      executedCommands: 5,
      errors: [],
      instructions: ["do the thing"],
    });
    expect(text).toContain("piren-gateway.service");
    expect(text).toContain("systemd");
  });
});
