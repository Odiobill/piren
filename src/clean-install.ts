import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

/**
 * Clean-install verification core.
 *
 * `assessCleanInstall` is the pure, unit-testable heart: given the observed
 * state of a freshly installed Piren (dist artifacts, binary behavior, Pi
 * runtime source), it produces a structured pass/fail report with a check per
 * concern. `runCleanInstallCheck` orchestrates the real npm install in an
 * isolated clean HOME and feeds the resulting probe to `assessCleanInstall`.
 *
 * The most common real-world failure this catches: a github or tarball install
 * that does not contain the committed `dist/` release artifacts expected by the
 * installed `piren` binary.
 */

export type CleanInstallStatus = "ok" | "warn" | "fail";

export interface CleanInstallCheck {
  id: string;
  status: CleanInstallStatus;
  message: string;
}

export type PiRuntimeSource = "path" | "npx-latest" | "unavailable";

/**
 * The observed state of one fresh install. The orchestration script gathers
 * this by running real `npm install` + `piren` commands; tests construct it
 * directly so the assessment logic is exercised without any network.
 */
export interface CleanInstallProbe {
  installDir: string;
  cliJsExists: boolean;
  publicIndexExists: boolean;
  extensionJsExists: boolean;
  binaryRuns: boolean;
  binaryVersion?: string | undefined;
  piRuntimeSource: PiRuntimeSource;
  piRuntimeVersion?: string | undefined;
  piRuntimeError?: string | undefined;
}

export interface CleanInstallAssessment {
  ok: boolean;
  installDir: string;
  checks: CleanInstallCheck[];
}

const DIST_HINT =
  "This usually means dist/ was not included in the installed package. " +
  "Piren expects committed release artifacts for github installs, and `npm pack` runs " +
  "the prepack build before creating an npm tarball.";

export function assessCleanInstall(probe: CleanInstallProbe): CleanInstallAssessment {
  const checks: CleanInstallCheck[] = [];

  checks.push({
    id: "dist-cli",
    status: probe.cliJsExists ? "ok" : "fail",
    message: probe.cliJsExists
      ? `dist/src/cli.js present at ${probe.installDir}.`
      : `dist/src/cli.js is MISSING at ${probe.installDir}. ${DIST_HINT}`,
  });

  checks.push({
    id: "dist-public",
    status: probe.publicIndexExists ? "ok" : "fail",
    message: probe.publicIndexExists
      ? "dist/public/index.html present (web UI frontend asset)."
      : `dist/public/index.html is MISSING. ${DIST_HINT}`,
  });

  checks.push({
    id: "dist-extension",
    status: probe.extensionJsExists ? "ok" : "fail",
    message: probe.extensionJsExists
      ? "dist/src/pi-extension.js present (Piren extension entry point)."
      : `dist/src/pi-extension.js is MISSING. ${DIST_HINT}`,
  });

  // If the core dist did not build, the binary cannot run, so cascade cleanly
  // rather than masking the real cause with a confusing runtime stack.
  const canRun = probe.cliJsExists && probe.binaryRuns;
  checks.push({
    id: "binary-runs",
    status: canRun ? "ok" : "fail",
    message: canRun
      ? `Installed piren binary runs${probe.binaryVersion ? ` (version ${probe.binaryVersion})` : ""}.`
      : "Installed piren binary did not run. See the dist checks above.",
  });

  // The Pi runtime policy is only verifiable through the installed binary
  // (it is read from `piren doctor` output). If the binary did not run, we
  // cannot honestly report the runtime state, so cascade to fail rather than
  // printing a misleading warn next to an already-failing binary check.
  let runtimeStatus: CleanInstallStatus;
  let runtimeMessage: string;
  if (!probe.binaryRuns) {
    runtimeStatus = "fail";
    runtimeMessage = "Pi runtime policy could not be verified because the installed binary did not run.";
  } else if (probe.piRuntimeSource === "path") {
    runtimeStatus = "ok";
    runtimeMessage = `Pi binary resolved on PATH${probe.piRuntimeVersion ? ` version ${probe.piRuntimeVersion}` : ""}.`;
  } else if (probe.piRuntimeSource === "npx-latest") {
    runtimeStatus = "ok";
    runtimeMessage = "No local pi on PATH; Piren will use npx --yes -p @earendil-works/pi-coding-agent@latest pi.";
  } else {
    runtimeStatus = "warn";
    runtimeMessage = `Could not verify Pi runtime: ${probe.piRuntimeError ?? "unknown error"}.`;
  }
  checks.push({ id: "pi-runtime", status: runtimeStatus, message: runtimeMessage });

  return {
    ok: checks.every((check) => check.status !== "fail"),
    installDir: probe.installDir,
    checks,
  };
}

export function formatCleanInstallReport(report: CleanInstallAssessment): string {
  const lines = ["Piren clean-install check"];
  lines.push(`install_dir: ${report.installDir}`);
  lines.push(`result: ${report.ok ? "PASS" : "FAIL"}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration: real npm install in an isolated clean environment.
// Kept separate from the pure core so tests never touch the network.
// ---------------------------------------------------------------------------

export interface CleanInstallOptions {
  /** Package spec to install, e.g. "github:Odiobill/piren" or a tarball path. */
  spec: string;
  /** npm prefix (install root). Created if missing. */
  prefix: string;
  /** Isolated HOME for the install + verification (clean config dir). */
  cleanHome: string;
  /**
   * PATH for the verification commands. Should contain node, npm, and at
   * least one of pi/npx so the Pi runtime policy can be exercised. If the
   * caller wants to force the npx-latest branch, omit pi from this PATH.
   */
  pathEnv: string;
  /** Node binary, defaults to process.execPath. */
  nodeBin?: string;
  /** npm binary, defaults to "npm". */
  npmBin?: string;
  /** Extra args passed to npm install (e.g. ["--no-save"]). */
  npmArgs?: string[];
  /** Whether to pass npm's --allow-scripts flag. Kept for operator compatibility. */
  allowInstallScripts?: boolean;
  /** Whether to delete the prefix/cleanHome at the end. Default false (keep for inspection). */
  cleanup?: boolean;
  /** Optional logger. */
  log?: (message: string) => void;
}

export interface CleanInstallResult extends CleanInstallAssessment {
  probe: CleanInstallProbe;
}

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Run the clean-install verification end to end against a real npm install. */
export async function runCleanInstallCheck(options: CleanInstallOptions): Promise<CleanInstallResult> {
  const log = options.log ?? (() => {});
  const nodeBin = options.nodeBin ?? process.execPath;
  const npmBin = options.npmBin ?? "npm";
  await mkdir(options.prefix, { recursive: true });
  await mkdir(options.cleanHome, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.cleanHome,
    PATH: options.pathEnv,
    // A truly clean install must not inherit the dev machine's npmrc or cache.
    npm_config_cache: join(options.cleanHome, ".npm-cache"),
    npm_config_userconfig: join(options.cleanHome, ".npmrc"),
    npm_config_prefix: options.prefix,
  };
  delete env.XDG_CONFIG_HOME;

  const installArgs = ["install", "--prefix", options.prefix];
  if (options.allowInstallScripts) installArgs.push("--allow-scripts");
  installArgs.push(options.spec);
  if (options.npmArgs) installArgs.push(...options.npmArgs);

  log(`npm install ${installArgs.filter((a) => !a.startsWith("--prefix")).join(" ")}`);
  const install = await run(npmBin, installArgs, { cwd: options.prefix, env, timeout: 180_000 });
  if (install.code !== 0) {
    log(`npm install exited ${install.code}\n${install.stderr}`);
  }

  const installDir = join(options.prefix, "node_modules", "piren");
  const cliJs = join(installDir, "dist", "src", "cli.js");
  const publicIndex = join(installDir, "dist", "public", "index.html");
  const extensionJs = join(installDir, "dist", "src", "pi-extension.js");

  // Probe the installed binary: it must print "Piren status" (or version) on
  // a no-network command. We run `piren status` against an explicit disposable
  // vault so it does not depend on the clean HOME having any config.
  const vaultRoot = join(options.cleanHome, "verify-vault");
  const verifyEnv = { ...env };
  const verifyArgs = ["--vault-root", vaultRoot, "--agent", "piren", "status"];
  let binaryRuns = false;
  let binaryVersion: string | undefined;
  if (await exists(cliJs)) {
    // init the vault first so status has a SOUL.md to read
    await run(nodeBin, [cliJs, "init", "--vault-root", vaultRoot], { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
    const statusRun = await run(nodeBin, [cliJs, ...verifyArgs], { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
    binaryRuns = statusRun.code === 0 && statusRun.stdout.includes("Piren status");
    // Read the package.json version as the binary version marker.
    try {
      const pkg = JSON.parse(await readFile(join(installDir, "package.json"), "utf8")) as { version?: string };
      if (pkg.version) binaryVersion = pkg.version;
    } catch {
      // ignore
    }
  }

  // Probe the Pi runtime policy the way piren doctor would, but without
  // requiring the full bootstrap (we only need the runtime resolution). We
  // run `piren doctor` in the clean env: it reports pi-runtime regardless of
  // config state, so we can parse the source.
  let piRuntimeSource: PiRuntimeSource = "unavailable";
  let piRuntimeVersion: string | undefined;
  let piRuntimeError: string | undefined;
  if (await exists(cliJs)) {
    const doctorRun = await run(nodeBin, [cliJs, "doctor"], { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
    const text = `${doctorRun.stdout}\n${doctorRun.stderr}`;
    if (text.includes("Pi binary found on PATH")) {
      piRuntimeSource = "path";
      const m = text.match(/version\s+([0-9][0-9A-Za-z.\-]*)/);
      if (m && m[1]) piRuntimeVersion = m[1];
    } else if (text.includes("npx --yes -p @earendil-works/pi-coding-agent@latest")) {
      piRuntimeSource = "npx-latest";
    } else if (text.includes("Could not verify Pi runtime")) {
      piRuntimeSource = "unavailable";
      piRuntimeError = "doctor reported it could not verify the Pi runtime.";
    } else if (text.includes("Neither pi nor npx was found")) {
      piRuntimeSource = "unavailable";
      piRuntimeError = "Neither pi nor npx was found on PATH.";
    }
  }

  const probe: CleanInstallProbe = {
    installDir,
    cliJsExists: await exists(cliJs),
    publicIndexExists: await exists(publicIndex),
    extensionJsExists: await exists(extensionJs),
    binaryRuns,
    binaryVersion,
    piRuntimeSource,
    piRuntimeVersion,
    piRuntimeError,
  };

  if (options.cleanup) {
    await rm(options.prefix, { recursive: true, force: true });
    await rm(options.cleanHome, { recursive: true, force: true });
  }

  const assessment = assessCleanInstall(probe);
  return { ...assessment, probe };
}

/**
 * Convenience entry for a full default run against the real github spec.
 * Used by scripts/clean-install-check.ts. Returns the formatted report string.
 */
export async function defaultCleanInstallCheck(spec: string, opts?: Partial<CleanInstallOptions>): Promise<CleanInstallAssessment> {
  const base = await mkdtemp(join(tmpdir(), "piren-clean-"));
  const prefix = join(base, "prefix");
  const cleanHome = join(base, "home");
  // Inherit a PATH that has node/npm/pi so the runtime policy is exercised
  // against the real machine, but otherwise keep the HOME clean.
  const pathEnv = process.env.PATH ?? "";
  const result = await runCleanInstallCheck({
    spec,
    prefix,
    cleanHome,
    pathEnv,
    log: (m) => console.error(m),
    cleanup: true,
    ...opts,
  });
  return result;
}
