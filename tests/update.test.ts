import { describe, expect, it } from "vitest";
import { buildUpdateCommand, executePirenUpdate, formatUpdateReport } from "../src/update.js";

describe("piren update", () => {
  it("builds the default GitHub global install command", () => {
    const command = buildUpdateCommand();

    expect(command.command).toBe("npm");
    expect(command.args).toEqual(["install", "-g", "--install-links", "github:Odiobill/piren"]);
  });

  it("executes the update command through injected deps", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const report = await executePirenUpdate({
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "updated\n", stderr: "" };
      },
    });

    expect(calls).toEqual([
      { command: "npm", args: ["install", "-g", "--install-links", "github:Odiobill/piren"] },
    ]);
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toBe("updated\n");
  });

  it("formats success and failure reports", () => {
    const okText = formatUpdateReport({
      ok: true,
      command: "npm",
      args: ["install", "-g", "--install-links", "github:Odiobill/piren"],
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    });
    expect(okText).toContain("Piren update: ok");
    expect(okText).toContain("npm install -g --install-links github:Odiobill/piren");
    expect(okText).toContain("ok");

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
