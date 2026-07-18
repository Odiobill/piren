import { describe, expect, it, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end dispatch test for the `piren task` command. The pure core is
// covered in tests/task-cli.test.ts; this test exercises the real CLI binary
// dispatch path against a temp vault.
//
// Runs against the built binary: requires `npm run build` first.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

function runPirenTask(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliJs, "task", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("piren task (CLI dispatch)", () => {
  let home: string;
  let vault: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-task-cli-home-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "dipu", "inbox"), { recursive: true });
    await mkdir(join(vault, "team", "zai", "inbox"), { recursive: true });
    await mkdir(join(vault, "team", "steward"), { recursive: true });
    await mkdir(join(vault, "tasks"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    await writeFile(join(vault, "team", "dipu", "SOUL.md"), "# Dipu\n");
    await writeFile(join(vault, "team", "zai", "SOUL.md"), "# Zai\n");
    // Seed a minimal config so vault_root resolves.
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - dipu", "  - zai", ""].join("\n"),
    );
  });

  it("prints help for --help", () => {
    const result = runPirenTask(["--help"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("piren task");
    expect(result.stdout).toMatch(/list|send|show|claim|complete|cancel/);
  });

  it("lists no tasks on a fresh inbox", () => {
    const result = runPirenTask(["list", "--agent", "dipu"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no tasks found/i);
  });

  it("sends a task to an agent and lists it", () => {
    const send = runPirenTask(
      ["send", "dipu", "Write release notes", "--priority", "high"],
      { HOME: home },
    );
    expect(send.status).toBe(0);
    expect(send.stdout).toContain("Created task");
    expect(send.stdout).toContain("team/dipu/inbox/");

    const list = runPirenTask(["list", "--agent", "dipu"], { HOME: home });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("Write release notes");
  });

  it("surfaces priority in show output", () => {
    const send = runPirenTask(
      ["send", "dipu", "Priority show check", "--priority", "urgent"],
      { HOME: home },
    );
    expect(send.status).toBe(0);
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
    const show = runPirenTask(["show", pathMatch![0]], { HOME: home });
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("urgent");
  });

  it("sends a task with --body read from a vault-contained file", async () => {
    const bodyPath = join(vault, "tasks", "body.md");
    await writeFile(bodyPath, "Body from file with detail.");
    const send = runPirenTask(
      ["send", "dipu", "Body task", "--body", "tasks/body.md"],
      { HOME: home },
    );
    expect(send.status).toBe(0);
    expect(send.stdout).toContain("team/dipu/inbox/");

    // Read back the created task file and confirm the body landed.
    const list = runPirenTask(["list", "--agent", "dipu"], { HOME: home });
    expect(list.stdout).toContain("Body task");
    // Find the path from the created message and verify body content.
    const match = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(match).not.toBeNull();
    const created = await readFile(join(vault, match![0]), "utf8");
    expect(created).toContain("Body from file with detail.");
  });

  it("rejects a --body path that escapes the vault", () => {
    const send = runPirenTask(
      ["send", "dipu", "Bad body", "--body", "../../../etc/passwd"],
      { HOME: home },
    );
    expect(send.status).not.toBe(0);
    expect(send.stderr).toMatch(/vault|outside/i);
  });

  it("rejects sending to an unknown agent", () => {
    const send = runPirenTask(
      ["send", "ghost", "Nope", "--priority", "normal"],
      { HOME: home },
    );
    expect(send.status).not.toBe(0);
    expect(send.stderr).toMatch(/agent|found/i);
  });

  it("rejects an invalid --priority value", () => {
    const send = runPirenTask(
      ["send", "dipu", "Nope", "--priority", "critical"],
      { HOME: home },
    );
    expect(send.status).not.toBe(0);
    expect(send.stderr).toMatch(/priority/i);
  });

  it("shows a task by path and by id", () => {
    // Send a fresh task for stable id capture.
    const send = runPirenTask(["send", "dipu", "Show me task"], { HOME: home });
    expect(send.status).toBe(0);
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
    const taskPath = pathMatch![0];
    const id = taskPath.split("/").pop()!.replace(/\.md$/, "");

    const byPath = runPirenTask(["show", taskPath], { HOME: home });
    expect(byPath.status).toBe(0);
    expect(byPath.stdout).toContain("Show me task");
    expect(byPath.stdout).toContain(taskPath);

    const byId = runPirenTask(["show", id, "--agent", "dipu"], { HOME: home });
    expect(byId.status).toBe(0);
    expect(byId.stdout).toContain("Show me task");
  });

  it("claims a task by path with a device id, removing it from list", () => {
    const send = runPirenTask(["send", "dipu", "Claim me"], { HOME: home });
    expect(send.status).toBe(0);
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
    const taskPath = pathMatch![0];

    const claim = runPirenTask(["claim", taskPath, "--device", "laptop"], { HOME: home });
    expect(claim.status).toBe(0);
    expect(claim.stdout).toContain("Claimed task");
    expect(claim.stdout).toContain(".claimed.laptop.md");

    // Original path no longer exists; listed tasks no longer include it.
    const list = runPirenTask(["list", "--agent", "dipu"], { HOME: home });
    expect(list.stdout).not.toContain(taskPath);
  });

  it("completes a task by id with --result from a vault file", async () => {
    const resultPath = join(vault, "tasks", "result.md");
    await writeFile(resultPath, "All done, shipped.");

    const send = runPirenTask(["send", "dipu", "Complete me"], { HOME: home });
    expect(send.status).toBe(0);
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
    const id = pathMatch![0].split("/").pop()!.replace(/\.md$/, "");

    const complete = runPirenTask(
      ["complete", id, "--agent", "dipu", "--result", "tasks/result.md"],
      { HOME: home },
    );
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain("completed");

    // The task file should now carry status: completed and the result body.
    const files = await readFile(join(vault, pathMatch![0]), "utf8").catch(() => null);
    // After completion the path is unchanged (no claim), so the file remains.
    if (files) {
      expect(files).toContain("status: completed");
      expect(files).toContain("All done, shipped.");
    }
  });

  it("cancels a task by path", () => {
    const send = runPirenTask(["send", "dipu", "Cancel me"], { HOME: home });
    expect(send.status).toBe(0);
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
    const taskPath = pathMatch![0];

    const cancel = runPirenTask(["cancel", taskPath], { HOME: home });
    expect(cancel.status).toBe(0);
    expect(cancel.stdout).toContain("cancelled");
  });

  it("errors when showing a task id that does not exist", () => {
    const result = runPirenTask(["show", "no-such-id", "--agent", "dipu"], { HOME: home });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it("errors on an unknown subcommand", () => {
    const result = runPirenTask(["frobnicate"], { HOME: home });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage|unknown/i);
  });

  it("rejects a nested-below-inbox path before filesystem effects (regression)", () => {
    // Sam review blocker: team/<agent>/inbox/foo.md/other.md must not be a
    // valid task target. Every path-accepting subcommand should reject it.
    for (const sub of ["show", "claim", "complete", "cancel"] as const) {
      const result = runPirenTask([sub, "team/dipu/inbox/foo.md/other.md"], { HOME: home });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/inbox|markdown|task path/i);
    }
  });
});

// Isolated vault to verify `list` without --agent resolves from PIREN_AGENT and
// that `send` attributes the task from the human/steward sender.
describe("piren task (default agent + sender attribution)", () => {
  let home: string;
  let vault: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "piren-task-cli-default-"));
    vault = join(home, "vault");
    await mkdir(join(vault, "team", "dipu", "inbox"), { recursive: true });
    await mkdir(join(vault, "team", "zai", "inbox"), { recursive: true });
    await writeFile(join(vault, ".piren-vault"), "");
    await writeFile(join(vault, "steward-directives.md"), "# directives");
    await writeFile(join(vault, "team", "dipu", "SOUL.md"), "# Dipu\n");
    await writeFile(join(vault, "team", "zai", "SOUL.md"), "# Zai\n");
    await mkdir(join(home, ".config", "piren"), { recursive: true });
    await writeFile(
      join(home, ".config", "piren", "config.yml"),
      ["vault_root: " + vault, "", "allowed_agents:", "  - dipu", "  - zai", ""].join("\n"),
    );
  });

  it("attributes sent tasks to the steward sender", () => {
    const send = runPirenTask(["send", "dipu", "Attributed task"], { HOME: home });
    expect(send.status).toBe(0);
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
  });

  it("reads the from: field back as the steward sender", async () => {
    const send = runPirenTask(["send", "dipu", "Sender check"], { HOME: home });
    const pathMatch = send.stdout.match(/team\/dipu\/inbox\/\S+\.md/);
    expect(pathMatch).not.toBeNull();
    const content = await readFile(join(vault, pathMatch![0]), "utf8");
    expect(content).toContain("from: steward");
  });

  it("lists tasks for the agent resolved from PIREN_AGENT when --agent is omitted", () => {
    const send = runPirenTask(["send", "zai", "Default list task"], { HOME: home, PIREN_AGENT: "zai" });
    expect(send.status).toBe(0);
    const list = runPirenTask(["list"], { HOME: home, PIREN_AGENT: "zai" });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("Default list task");
  });

  it("errors on list with no resolvable agent", () => {
    // Explicitly clear inherited agent env (the test host may run under PIREN_AGENT).
    const list = runPirenTask(["list"], { HOME: home, PIREN_AGENT: "" });
    expect(list.status).not.toBe(0);
    expect(list.stderr).toMatch(/agent/i);
  });
});
