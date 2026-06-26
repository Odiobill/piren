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
    else if (probe.piRuntimeSource === "npx-latest") {
        runtimeStatus = "ok";
        runtimeMessage = "No local pi on PATH; Piren will use npx --yes -p @earendil-works/pi-coding-agent@latest pi.";
    }
    else {
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
export function formatCleanInstallReport(report) {
    const lines = ["Piren clean-install check"];
    lines.push(`install_dir: ${report.installDir}`);
    lines.push(`result: ${report.ok ? "PASS" : "FAIL"}`);
    lines.push("");
    for (const check of report.checks) {
        lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
    }
    return lines.join("\n");
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
    const installArgs = ["install", "--prefix", options.prefix, "--install-links"];
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
        else if (text.includes("npx --yes -p @earendil-works/pi-coding-agent@latest")) {
            piRuntimeSource = "npx-latest";
        }
        else if (text.includes("Could not verify Pi runtime")) {
            piRuntimeSource = "unavailable";
            piRuntimeError = "doctor reported it could not verify the Pi runtime.";
        }
        else if (text.includes("Neither pi nor npx was found")) {
            piRuntimeSource = "unavailable";
            piRuntimeError = "Neither pi nor npx was found on PATH.";
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