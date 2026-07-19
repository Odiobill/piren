import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

export type PiRuntimeSource = "path" | "unavailable";

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
  } else {
    runtimeStatus = "fail";
    runtimeMessage = `Pi is required on PATH. Install Pi with: curl -fsSL https://pi.dev/install.sh | sh. Details: ${probe.piRuntimeError ?? "unknown error"}.`;
  }
  checks.push({ id: "pi-runtime", status: runtimeStatus, message: runtimeMessage });

  return {
    ok: checks.every((check) => check.status !== "fail"),
    installDir: probe.installDir,
    checks,
  };
}

export function formatCleanInstallReport(report: CleanInstallReportResult): string {
  const lines = ["Piren clean-install check"];
  if (report.source) {
    const s = report.source;
    lines.push(`source: ${s.kind}`);
    lines.push(`spec: ${s.spec}`);
    if (s.tarballPath) lines.push(`tarball: ${s.tarballPath}`);
    if (s.packageName && s.packageVersion) lines.push(`package: ${s.packageName}@${s.packageVersion}`);
    if (s.packedFileCount !== undefined) lines.push(`packed files: ${s.packedFileCount}`);
    if (s.artifactsOk !== undefined) {
      lines.push(`packed artifacts: ${s.artifactsOk ? "OK" : `MISSING${s.missing ? " " + s.missing.join(", ") : ""}`}`);
    }
  }
  lines.push(`install_dir: ${report.installDir || "<not installed>"}`);
  lines.push(`result: ${report.ok ? "PASS" : "FAIL"}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Packed-tarball install verification (ADR-0033 Slice R1).
//
// The default clean-install path packs the exact local source via `npm pack`,
// validates the packed file surface, then installs that tarball into an
// isolated HOME/prefix. This removes the `github:` Git-dependency (and the
// npm-11 `--install-links` workaround) from the normal path, so it is not
// blocked by EALLOWGIT policies. GitHub/explicit-spec installs remain an
// opt-in escape hatch.
// ---------------------------------------------------------------------------

/**
 * Required packed-surface contract: the runtime artifacts the installed CLI
 * needs PLUS a stable docs file, so a regression that drops `docs/` from
 * `package.json` `files` is caught here. The installed-runtime probe
 * (`assessCleanInstall`) stays scoped to the three dist runtime files; this
 * constant governs the pack surface only.
 */
export const REQUIRED_PACKED_ARTIFACTS = [
  "dist/src/cli.js",
  "dist/public/index.html",
  "dist/src/pi-extension.js",
  "docs/getting-started.md",
] as const;

/** Discriminated install-spec resolved from CLI args. */
export type InstallSpec =
  | { kind: "packed-tarball"; source: "local" }
  | { kind: "prebuilt-tarball"; spec: string }
  | { kind: "explicit"; spec: string };

/** Result of validating a packed file surface. */
export interface PackArtifactsResult {
  ok: boolean;
  missing: string[];
  presentCount: number;
}

/** Parsed `npm pack --json` entry. */
export interface ParsedPackJson {
  filename: string;
  packageName: string;
  packageVersion: string;
  packedFiles: string[];
}

/** Injected command/filesystem deps used by `buildLocalTarball`. */
export interface PackRunDeps {
  pack(cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  remove(path: string): Promise<void>;
}

/** Outcome of packing + surface-validating the local source. */
export interface PackOutcome {
  ok: boolean;
  tarballPath: string | undefined;
  packageName: string | undefined;
  packageVersion: string | undefined;
  packedFiles: string[];
  missing: string[];
  error: string | undefined;
}

/** Source attribution printed in the final report. */
export interface CleanInstallSourceInfo {
  kind: "packed-tarball" | "explicit-spec" | "prebuilt-tarball";
  spec: string;
  tarballPath?: string;
  packageName?: string;
  packageVersion?: string;
  packedFileCount?: number;
  artifactsOk?: boolean;
  missing?: string[];
}

/** Assessment extended with optional source attribution for the report. */
export interface CleanInstallReportResult extends CleanInstallAssessment {
  source?: CleanInstallSourceInfo;
}

/** Whether a spec string denotes a local prepacked npm tarball file. */
export function isLocalTarballSpec(spec: string): boolean {
  if (spec.includes("://")) return false;
  return spec.endsWith(".tgz");
}

/** Resolve the install spec from CLI args. Default = packed-tarball/local; a
 *  local `.tgz` positional selects the surface-validated prebuilt-tarball path;
 *  any other positional is the explicit escape hatch (github:/git+ specs). */
export function resolveInstallSpec(args: string[]): InstallSpec {
  const explicit = args.find((a) => !a.startsWith("-"));
  if (explicit === undefined) return { kind: "packed-tarball", source: "local" };
  if (isLocalTarballSpec(explicit)) return { kind: "prebuilt-tarball", spec: explicit };
  return { kind: "explicit", spec: explicit };
}

/** Pure: check a packed file surface contains every required runtime artifact. */
export function checkPackedArtifacts(packedFiles: string[]): PackArtifactsResult {
  const normalized = packedFiles.map((f) => f.replace(/^package\//, "").replace(/\\/g, "/"));
  const present = REQUIRED_PACKED_ARTIFACTS.filter((req) => normalized.includes(req));
  const missing = REQUIRED_PACKED_ARTIFACTS.filter((req) => !normalized.includes(req));
  return { ok: missing.length === 0, missing, presentCount: present.length };
}

/**
 * Parse `npm pack --json` stdout. Handles both the current object-keyed
 * shape (`{ "piren": {...} }`) and the older array shape (`[ {...} ]`).
 * Returns null when the output is not parseable or has no filename.
 */
export function parseNpmPackJson(stdout: string): ParsedPackJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  let entry: unknown;
  if (Array.isArray(parsed)) {
    entry = parsed[0];
  } else {
    const values = Object.values(parsed as Record<string, unknown>);
    entry = values[0];
  }
  if (entry === null || typeof entry !== "object") return null;

  const e = entry as { filename?: unknown; name?: unknown; version?: unknown; files?: unknown };
  if (typeof e.filename !== "string" || e.filename === "") return null;

  const packedFiles: string[] = [];
  if (Array.isArray(e.files)) {
    for (const f of e.files) {
      if (f !== null && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
        packedFiles.push((f as { path: string }).path);
      }
    }
  }

  return {
    filename: e.filename,
    packageName: typeof e.name === "string" ? e.name : "",
    packageVersion: typeof e.version === "string" ? e.version : "",
    packedFiles,
  };
}

/** Whether an install spec needs npm's `--install-links` (git/github only). */
export function needsInstallLinks(spec: string): boolean {
  return spec.startsWith("github:") || spec.startsWith("git+") || spec.endsWith(".git");
}

/**
 * Build the local tarball via `npm pack --json` using injected deps, then
 * validate its packed surface. The tarball is created in `cwd` (the repo
 * root); the returned `tarballPath` is the absolute path the caller installs
 * and later removes.
 */
export async function buildLocalTarball(deps: PackRunDeps, cwd: string): Promise<PackOutcome> {
  const required = [...REQUIRED_PACKED_ARTIFACTS];
  const res = await deps.pack(cwd);
  if (res.code !== 0) {
    return {
      ok: false,
      tarballPath: undefined,
      packageName: undefined,
      packageVersion: undefined,
      packedFiles: [],
      missing: required,
      error: `npm pack exited ${res.code}${res.stderr ? `: ${res.stderr.trim()}` : ""}`,
    };
  }

  const parsed = parseNpmPackJson(res.stdout);
  if (parsed === null) {
    return {
      ok: false,
      tarballPath: undefined,
      packageName: undefined,
      packageVersion: undefined,
      packedFiles: [],
      missing: required,
      error: "Could not parse `npm pack` JSON output.",
    };
  }

  const surface = checkPackedArtifacts(parsed.packedFiles);
  return {
    ok: surface.ok,
    tarballPath: join(cwd, parsed.filename),
    packageName: parsed.packageName,
    packageVersion: parsed.packageVersion,
    packedFiles: parsed.packedFiles,
    missing: surface.missing,
    error: undefined,
  };
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
   * PATH for the verification commands. Should contain node, npm, and pi so
   * the Pi runtime policy can be exercised. If the caller wants to exercise
   * the missing-Pi branch, omit pi from this PATH.
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
  // `--install-links` is only needed for git/github specs (the npm-11 symlink
  // workaround). Tarball installs always extract into node_modules, so the
  // normal packed-tarball path does not depend on it (ADR-0033 Slice R1).
  if (needsInstallLinks(options.spec)) installArgs.push("--install-links");
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

  // Probe the installed binary through npm's linked command, not only through
  // node dist/src/cli.js. This catches npm git installs that leave a broken bin
  // symlink unless --install-links is used.
  const vaultRoot = join(options.cleanHome, "verify-vault");
  const verifyEnv = { ...env, PATH: `${join(options.prefix, "node_modules", ".bin")}:${join(options.prefix, "bin")}:${env.PATH ?? ""}` };
  const binPath = join(options.prefix, "node_modules", ".bin", process.platform === "win32" ? "piren.cmd" : "piren");
  const verifyArgs = ["--vault-root", vaultRoot, "--agent", "piren", "status"];
  let binaryRuns = false;
  let binaryVersion: string | undefined;
  if (await exists(cliJs)) {
    // init the vault first so status has a SOUL.md to read
    await run(nodeBin, [cliJs, "init", "--vault-root", vaultRoot], { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
    const statusRun = await run(binPath, verifyArgs, { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
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
    } else if (text.includes("Could not verify Pi runtime")) {
      piRuntimeSource = "unavailable";
      piRuntimeError = "doctor reported it could not verify the Pi runtime.";
    } else if (text.includes("Pi is required") || text.includes("Pi Coding Agent not found")) {
      piRuntimeSource = "unavailable";
      piRuntimeError = "Pi was not found on PATH.";
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

/** Real `npm pack` adapter for `buildLocalTarball`. */
export function createRealPackDeps(): PackRunDeps {
  return {
    pack: (cwd) => run("npm", ["pack", "--json"], { cwd, env: process.env, timeout: 180_000 }),
    remove: (path) => rm(path, { force: true }),
  };
}

export interface PackedCheckOptions {
  /** Repo root to pack from (must contain package.json). */
  repoRoot: string;
  /** PATH for verification (node/npm/pi). Defaults to process.env.PATH. */
  pathEnv?: string;
  /** Keep the packed tarball and install dirs for inspection. Default: clean up. */
  keep?: boolean;
  /** Pass npm's --allow-scripts during install. */
  allowInstallScripts?: boolean;
  /** Optional logger. */
  log?: (message: string) => void;
  /** Injected pack deps for tests; defaults to the real npm adapter. */
  packDeps?: PackRunDeps;
  /** Injected install runner for tests; defaults to runCleanInstallCheck. */
  runInstall?: InstallRunner;
}

/** Install runner signature, matching runCleanInstallCheck. Injected for tests. */
export type InstallRunner = (options: CleanInstallOptions) => Promise<CleanInstallResult>;

/**
 * Default clean-install path (ADR-0033 Slice R1): pack the exact local source
 * via `npm pack`, validate the packed surface, then install that tarball into
 * an isolated HOME/prefix and run the existing dist/binary/Pi checks. No
 * `github:` fetch and no `--install-links` in the normal path.
 *
 * Cleanup invariant: any tarball that was produced is removed unless `keep`,
 * including the surface-missing failure path and thrown install errors
 * (enforced by a single try/finally around the whole post-pack body).
 */
export async function runPackedCleanInstallCheck(options: PackedCheckOptions): Promise<CleanInstallReportResult> {
  const log = options.log ?? (() => {});
  const packDeps = options.packDeps ?? createRealPackDeps();
  const runInstall = options.runInstall ?? runCleanInstallCheck;
  const keep = options.keep ?? false;

  log("clean-install-check: packing local tarball via `npm pack --json`");
  const pack = await buildLocalTarball(packDeps, options.repoRoot);

  const source: CleanInstallSourceInfo = {
    kind: "packed-tarball",
    spec: pack.tarballPath ?? "<no tarball produced>",
    artifactsOk: pack.ok && pack.missing.length === 0,
    ...(pack.tarballPath !== undefined ? { tarballPath: pack.tarballPath } : {}),
    ...(pack.packageName !== undefined ? { packageName: pack.packageName } : {}),
    ...(pack.packageVersion !== undefined ? { packageVersion: pack.packageVersion } : {}),
    ...(pack.packedFiles.length > 0 ? { packedFileCount: pack.packedFiles.length } : {}),
    ...(pack.missing.length > 0 ? { missing: pack.missing } : {}),
  };

  // Guarantee every path that produced a tarball removes it unless --keep.
  // Covers surface-missing early returns AND thrown install errors.
  try {
    if (!pack.ok || pack.tarballPath === undefined) {
      const message =
        pack.error !== undefined
          ? `Local \`npm pack\` failed: ${pack.error}`
          : `Packed tarball is missing required artifacts: ${pack.missing.join(", ")}. Run \`npm run build\` before packing.`;
      return {
        ok: false,
        installDir: "",
        checks: [{ id: "packed-surface", status: "fail", message }],
        source,
      };
    }

    const base = await mkdtemp(join(tmpdir(), "piren-clean-"));
    const prefix = join(base, "prefix");
    const cleanHome = join(base, "home");
    const pathEnv = options.pathEnv ?? process.env.PATH ?? "";

    const installOpts: CleanInstallOptions = {
      spec: pack.tarballPath,
      prefix,
      cleanHome,
      pathEnv,
      log,
      cleanup: !keep,
    };
    if (options.allowInstallScripts) installOpts.allowInstallScripts = true;

    const install = await runInstall(installOpts);

    return {
      ok: install.ok,
      installDir: install.installDir,
      checks: install.checks,
      source,
    };
  } finally {
    if (pack.tarballPath !== undefined && !keep) {
      await packDeps.remove(pack.tarballPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Prepacked-tarball verification (ADR-0033 P1).
//
// The publication workflow packs the tarball itself (`npm pack`) and then asks
// the clean-install machinery to validate + install THAT exact tarball. This
// composes the existing pieces: `checkPackedArtifacts` for the packed surface
// (the same REQUIRED_PACKED_ARTIFACTS contract) and `runCleanInstallCheck` for
// the isolated install + dist/binary/Pi-runtime probe. It is not a divergent
// verifier. The caller owns the tarball, so it is never removed here.
// ---------------------------------------------------------------------------

/** Injected tarball-listing deps (e.g. `tar -tf`) used to inspect a prepacked tarball. */
export interface TarballListDeps {
  list(tarballPath: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Parse `tar -tf` output into a list of entry paths (one per non-empty line). */
export function parseTarListing(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Real `tar -tf` adapter for inspecting a prepacked tarball's surface. */
export function createRealTarballListDeps(): TarballListDeps {
  return {
    list: (tarballPath) => run("tar", ["-tf", tarballPath], { cwd: process.cwd(), env: process.env, timeout: 60_000 }),
  };
}

export interface PrebuiltCheckOptions {
  /** Absolute path to an existing npm tarball to validate and install. */
  tarballPath: string;
  /** PATH for the install verification (node/npm/pi). Defaults to process.env.PATH. */
  pathEnv?: string;
  /** Injected tarball-listing deps for tests; defaults to the real tar adapter. */
  listDeps?: TarballListDeps;
  /** Injected install runner for tests; defaults to runCleanInstallCheck. */
  runInstall?: InstallRunner;
  /** Optional logger. */
  log?: (message: string) => void;
}

/**
 * Validate and install a PRE-PACKED npm tarball (ADR-0033 P1). This is the
 * publication path's verifier: the caller (the release workflow) owns the
 * tarball, so this validates its packed surface (the same
 * REQUIRED_PACKED_ARTIFACTS contract as the local-pack path) and then installs
 * that exact tarball through the existing `runCleanInstallCheck` machinery. It
 * never removes the tarball — the caller decides its lifecycle (e.g. publish).
 */
export async function runPrebuiltTarballCheck(options: PrebuiltCheckOptions): Promise<CleanInstallReportResult> {
  const log = options.log ?? (() => {});
  const listDeps = options.listDeps ?? createRealTarballListDeps();
  const runInstall = options.runInstall ?? runCleanInstallCheck;

  // Resolve an absolute tarball path: the isolated install runs with cwd set
  // to the clean prefix, so a relative tarball path would not resolve there.
  const tarballPath = resolve(options.tarballPath);

  log(`clean-install-check: inspecting prebuilt tarball ${tarballPath}`);
  const listing = await listDeps.list(tarballPath);
  if (listing.code !== 0) {
    const message = `Could not list tarball ${tarballPath} (tar exited ${listing.code})${listing.stderr ? `: ${listing.stderr.trim()}` : ""}.`;
    return {
      ok: false,
      installDir: "",
      checks: [{ id: "packed-surface", status: "fail", message }],
      source: { kind: "prebuilt-tarball", spec: tarballPath, tarballPath, artifactsOk: false },
    };
  }

  const files = parseTarListing(listing.stdout);
  const surface = checkPackedArtifacts(files);
  const source: CleanInstallSourceInfo = {
    kind: "prebuilt-tarball",
    spec: tarballPath,
    tarballPath,
    artifactsOk: surface.ok,
    ...(files.length > 0 ? { packedFileCount: files.length } : {}),
    ...(surface.missing.length > 0 ? { missing: surface.missing } : {}),
  };

  if (!surface.ok) {
    return {
      ok: false,
      installDir: "",
      checks: [
        { id: "packed-surface", status: "fail", message: `Prebuilt tarball is missing required artifacts: ${surface.missing.join(", ")}.` },
      ],
      source,
    };
  }

  const base = await mkdtemp(join(tmpdir(), "piren-clean-"));
  const prefix = join(base, "prefix");
  const cleanHome = join(base, "home");
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";

  const install = await runInstall({
    spec: tarballPath,
    prefix,
    cleanHome,
    pathEnv,
    log,
    cleanup: true,
  });

  return {
    ok: install.ok,
    installDir: install.installDir,
    checks: install.checks,
    source,
  };
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
