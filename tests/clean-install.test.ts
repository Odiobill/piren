import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessCleanInstall, type CleanInstallProbe, type CleanInstallAssessment } from "../src/clean-install.js";

describe("package install lifecycle", () => {
  it("does not run a build during github dependency install", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.prepare).toBeUndefined();
    expect(pkg.scripts?.prepack).toBe("npm run build");
  });
});

describe("assessCleanInstall", () => {
  it("passes when dist artifacts exist, the binary runs, and pi is on PATH", () => {
    const probe: CleanInstallProbe = {
      installDir: "/prefix/node_modules/piren",
      cliJsExists: true,
      publicIndexExists: true,
      extensionJsExists: true,
      binaryRuns: true,
      binaryVersion: "0.1.0",
      piRuntimeSource: "path",
      piRuntimeVersion: "0.79.9",
    };

    const result = assessCleanInstall(probe);

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "dist-cli",
      "dist-public",
      "dist-extension",
      "binary-runs",
      "pi-runtime",
    ]);
    expect(result.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("fails when dist/src/cli.js is missing from the installed package", () => {
    const probe: CleanInstallProbe = {
      installDir: "/prefix/node_modules/piren",
      cliJsExists: false,
      publicIndexExists: true,
      extensionJsExists: true,
      binaryRuns: false,
      binaryVersion: undefined,
      piRuntimeSource: "path",
      piRuntimeVersion: "0.79.9",
    };

    const result = assessCleanInstall(probe);

    expect(result.ok).toBe(false);
    const cli = result.checks.find((c) => c.id === "dist-cli")!;
    expect(cli.status).toBe("fail");
    expect(cli.message).toMatch(/dist.*installed package/i);
    expect(cli.message).toMatch(/prepack/i);
  });

  it("cascades binary failure when dist exists but the binary does not run", () => {
    const probe: CleanInstallProbe = {
      installDir: "/prefix/node_modules/piren",
      cliJsExists: true,
      publicIndexExists: true,
      extensionJsExists: true,
      binaryRuns: false,
      binaryVersion: undefined,
      piRuntimeSource: "unavailable",
      piRuntimeVersion: undefined,
    };

    const result = assessCleanInstall(probe);

    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "binary-runs")!.status).toBe("fail");
    expect(result.checks.find((c) => c.id === "pi-runtime")!.status).toBe("fail");
  });

  it("accepts npx-latest pi runtime when no local pi binary is present", () => {
    const probe: CleanInstallProbe = {
      installDir: "/prefix/node_modules/piren",
      cliJsExists: true,
      publicIndexExists: true,
      extensionJsExists: true,
      binaryRuns: true,
      binaryVersion: "0.1.0",
      piRuntimeSource: "npx-latest",
      piRuntimeVersion: undefined,
    };

    const result = assessCleanInstall(probe);

    expect(result.ok).toBe(true);
    const runtime = result.checks.find((c) => c.id === "pi-runtime")!;
    expect(runtime.status).toBe("ok");
    expect(runtime.message).toMatch(/npx/i);
  });

  it("warns on an unavailable pi runtime", () => {
    const probe: CleanInstallProbe = {
      installDir: "/prefix/node_modules/piren",
      cliJsExists: true,
      publicIndexExists: true,
      extensionJsExists: true,
      binaryRuns: true,
      binaryVersion: "0.1.0",
      piRuntimeSource: "unavailable",
      piRuntimeVersion: undefined,
    };

    const result = assessCleanInstall(probe);

    expect(result.ok).toBe(true);
    const runtime = result.checks.find((c) => c.id === "pi-runtime")!;
    expect(runtime.status).toBe("warn");
  });

  it("fails when the public frontend asset is missing", () => {
    const probe: CleanInstallProbe = {
      installDir: "/prefix/node_modules/piren",
      cliJsExists: true,
      publicIndexExists: false,
      extensionJsExists: true,
      binaryRuns: true,
      binaryVersion: "0.1.0",
      piRuntimeSource: "path",
      piRuntimeVersion: "0.79.9",
    };

    const result = assessCleanInstall(probe);

    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "dist-public")!.status).toBe("fail");
  });
});
