import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
const DIST_HINT = "This usually means dist/ was not included in the installed package. " +
    "Piren expects committed release artifacts for github installs, and `npm pack` runs " +
    "the prepack build before creating an npm tarball.";
export function assessCleanInstall(probe) {
    const checks = [];
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
    let runtimeStatus;
    let runtimeMessage;
    if (!probe.binaryRuns) {
        runtimeStatus = "fail";
        runtimeMessage = "Pi runtime policy could not be verified because the installed binary did not run.";
    }
    else if (probe.piRuntimeSource === "path") {
        runtimeStatus = "ok";
        runtimeMessage = `Pi binary resolved on PATH${probe.piRuntimeVersion ? ` version ${probe.piRuntimeVersion}` : ""}.`;
    }
    else {
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
export function formatCleanInstallReport(report) {
    const lines = ["Piren clean-install check"];
    if (report.source) {
        const s = report.source;
        lines.push(`source: ${s.kind}`);
        lines.push(`spec: ${s.spec}`);
        if (s.tarballPath)
            lines.push(`tarball: ${s.tarballPath}`);
        if (s.packageName && s.packageVersion)
            lines.push(`package: ${s.packageName}@${s.packageVersion}`);
        if (s.packedFileCount !== undefined)
            lines.push(`packed files: ${s.packedFileCount}`);
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
/** Required runtime artifacts the packed tarball must ship for the CLI to run. */
export const REQUIRED_PACKED_ARTIFACTS = [
    "dist/src/cli.js",
    "dist/public/index.html",
    "dist/src/pi-extension.js",
];
/** Resolve the install spec from CLI args. Default = packed-tarball/local. */
export function resolveInstallSpec(args) {
    const explicit = args.find((a) => !a.startsWith("-"));
    if (explicit !== undefined)
        return { kind: "explicit", spec: explicit };
    return { kind: "packed-tarball", source: "local" };
}
/** Pure: check a packed file surface contains every required runtime artifact. */
export function checkPackedArtifacts(packedFiles) {
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
export function parseNpmPackJson(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object")
        return null;
    let entry;
    if (Array.isArray(parsed)) {
        entry = parsed[0];
    }
    else {
        const values = Object.values(parsed);
        entry = values[0];
    }
    if (entry === null || typeof entry !== "object")
        return null;
    const e = entry;
    if (typeof e.filename !== "string" || e.filename === "")
        return null;
    const packedFiles = [];
    if (Array.isArray(e.files)) {
        for (const f of e.files) {
            if (f !== null && typeof f === "object" && typeof f.path === "string") {
                packedFiles.push(f.path);
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
export function needsInstallLinks(spec) {
    return spec.startsWith("github:") || spec.startsWith("git+") || spec.endsWith(".git");
}
/**
 * Build the local tarball via `npm pack --json` using injected deps, then
 * validate its packed surface. The tarball is created in `cwd` (the repo
 * root); the returned `tarballPath` is the absolute path the caller installs
 * and later removes.
 */
export async function buildLocalTarball(deps, cwd) {
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
function run(cmd, args, opts) {
    return new Promise((resolve) => {
        execFile(cmd, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
/** Run the clean-install verification end to end against a real npm install. */
export async function runCleanInstallCheck(options) {
    const log = options.log ?? (() => { });
    const nodeBin = options.nodeBin ?? process.execPath;
    const npmBin = options.npmBin ?? "npm";
    await mkdir(options.prefix, { recursive: true });
    await mkdir(options.cleanHome, { recursive: true });
    const env = {
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
    if (needsInstallLinks(options.spec))
        installArgs.push("--install-links");
    if (options.allowInstallScripts)
        installArgs.push("--allow-scripts");
    installArgs.push(options.spec);
    if (options.npmArgs)
        installArgs.push(...options.npmArgs);
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
    let binaryVersion;
    if (await exists(cliJs)) {
        // init the vault first so status has a SOUL.md to read
        await run(nodeBin, [cliJs, "init", "--vault-root", vaultRoot], { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
        const statusRun = await run(binPath, verifyArgs, { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
        binaryRuns = statusRun.code === 0 && statusRun.stdout.includes("Piren status");
        // Read the package.json version as the binary version marker.
        try {
            const pkg = JSON.parse(await readFile(join(installDir, "package.json"), "utf8"));
            if (pkg.version)
                binaryVersion = pkg.version;
        }
        catch {
            // ignore
        }
    }
    // Probe the Pi runtime policy the way piren doctor would, but without
    // requiring the full bootstrap (we only need the runtime resolution). We
    // run `piren doctor` in the clean env: it reports pi-runtime regardless of
    // config state, so we can parse the source.
    let piRuntimeSource = "unavailable";
    let piRuntimeVersion;
    let piRuntimeError;
    if (await exists(cliJs)) {
        const doctorRun = await run(nodeBin, [cliJs, "doctor"], { cwd: options.prefix, env: verifyEnv, timeout: 20_000 });
        const text = `${doctorRun.stdout}\n${doctorRun.stderr}`;
        if (text.includes("Pi binary found on PATH")) {
            piRuntimeSource = "path";
            const m = text.match(/version\s+([0-9][0-9A-Za-z.\-]*)/);
            if (m && m[1])
                piRuntimeVersion = m[1];
        }
        else if (text.includes("Could not verify Pi runtime")) {
            piRuntimeSource = "unavailable";
            piRuntimeError = "doctor reported it could not verify the Pi runtime.";
        }
        else if (text.includes("Pi is required") || text.includes("Pi Coding Agent not found")) {
            piRuntimeSource = "unavailable";
            piRuntimeError = "Pi was not found on PATH.";
        }
    }
    const probe = {
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
export function createRealPackDeps() {
    return {
        pack: (cwd) => run("npm", ["pack", "--json"], { cwd, env: process.env, timeout: 180_000 }),
        remove: (path) => rm(path, { force: true }),
    };
}
/**
 * Default clean-install path (ADR-0033 Slice R1): pack the exact local source
 * via `npm pack`, validate the packed surface, then install that tarball into
 * an isolated HOME/prefix and run the existing dist/binary/Pi checks. No
 * `github:` fetch and no `--install-links` in the normal path.
 */
export async function runPackedCleanInstallCheck(options) {
    const log = options.log ?? (() => { });
    const packDeps = options.packDeps ?? createRealPackDeps();
    log("clean-install-check: packing local tarball via `npm pack --json`");
    const pack = await buildLocalTarball(packDeps, options.repoRoot);
    const source = {
        kind: "packed-tarball",
        spec: pack.tarballPath ?? "<no tarball produced>",
        artifactsOk: pack.ok && pack.missing.length === 0,
        ...(pack.tarballPath !== undefined ? { tarballPath: pack.tarballPath } : {}),
        ...(pack.packageName !== undefined ? { packageName: pack.packageName } : {}),
        ...(pack.packageVersion !== undefined ? { packageVersion: pack.packageVersion } : {}),
        ...(pack.packedFiles.length > 0 ? { packedFileCount: pack.packedFiles.length } : {}),
        ...(pack.missing.length > 0 ? { missing: pack.missing } : {}),
    };
    if (!pack.ok || pack.tarballPath === undefined) {
        const message = pack.error !== undefined
            ? `Local \`npm pack\` failed: ${pack.error}`
            : `Packed tarball is missing required runtime artifacts: ${pack.missing.join(", ")}. Run \`npm run build\` before packing.`;
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
    const installOpts = {
        spec: pack.tarballPath,
        prefix,
        cleanHome,
        pathEnv,
        log,
        cleanup: !options.keep,
    };
    if (options.allowInstallScripts)
        installOpts.allowInstallScripts = true;
    const install = await runCleanInstallCheck(installOpts);
    // Remove the packed tarball from the repo root unless --keep.
    if (!options.keep) {
        await packDeps.remove(pack.tarballPath);
    }
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
export async function defaultCleanInstallCheck(spec, opts) {
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
//# sourceMappingURL=clean-install.js.map