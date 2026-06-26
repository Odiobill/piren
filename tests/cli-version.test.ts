import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// End-to-end dispatch test for the `piren version` command. The pure core
// (readVersion) is covered in tests/version.test.ts and the command
// recognition is covered in tests/parse-args.test.ts; this test exercises
// the real CLI binary dispatch path so a regression in the cli.ts branch
// cannot ship green.

const repoRoot = process.cwd();
const cliJs = join(repoRoot, "dist", "src", "cli.js");

describe("piren version (CLI dispatch)", () => {
  it("prints the package.json version when run against the built binary", () => {
    const result = spawnSync(process.execPath, [cliJs, "version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("works regardless of the caller working directory", () => {
    // The version command resolves package.json via import.meta.url, so it
    // must not depend on the caller's cwd (unlike a relative-path lookup).
    const result = spawnSync(process.execPath, [cliJs, "version"], {
      encoding: "utf8",
      cwd: "/tmp",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("unknown");
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});
