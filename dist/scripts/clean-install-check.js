#!/usr/bin/env tsx
/**
 * Piren clean-install validation (ADR-0033 Slice R1).
 *
 * Default path: pack the exact local source via `npm pack` and install that
 * tarball into an isolated clean HOME/prefix. This needs no `github:` fetch and
 * no `--install-links`, so it is not blocked by npm Git-dependency policies.
 *
 * Escape hatch: pass an explicit spec to install something else, e.g.
 *   npm run clean-install:check -- github:Odiobill/piren
 *   npm run clean-install:check -- /path/to/piren-0.1.0.tgz
 *
 * Verification (packed tarball or explicit spec):
 *   1. Packed surface contains dist/src/cli.js, dist/public/index.html,
 *      dist/src/pi-extension.js (packed-tarball path only).
 *   2. dist/src/cli.js, dist/public/index.html, dist/src/pi-extension.js exist
 *      in the installed package.
 *   3. The installed piren binary actually runs.
 *   4. The Pi runtime policy resolves: pi must be installed on PATH.
 *
 * Flags:
 *   --keep            Keep the packed tarball and install dirs for inspection.
 *   --allow-scripts   Pass npm's --allow-scripts during install.
 *
 * Usage:
 *   npm run clean-install:check
 *   npm run clean-install:check -- /abs/path/piren-0.1.0.tgz --keep
 *
 * Exits non-zero on any FAIL check, so it is CI-safe.
 */
import { resolveInstallSpec, runPackedCleanInstallCheck, runPrebuiltTarballCheck, defaultCleanInstallCheck, formatCleanInstallReport, } from "../src/clean-install.js";
async function main() {
    const args = process.argv.slice(2);
    const spec = resolveInstallSpec(args);
    const allowScripts = args.includes("--allow-scripts");
    const keep = args.includes("--keep");
    if (spec.kind === "packed-tarball") {
        console.error("clean-install-check: default path is local packed tarball (no github fetch)");
        const result = await runPackedCleanInstallCheck({
            repoRoot: process.cwd(),
            keep,
            allowInstallScripts: allowScripts,
            log: (m) => console.error(m),
        });
        console.log(formatCleanInstallReport(result));
        if (!result.ok) {
            console.error("clean-install-check: FAILED");
            process.exit(1);
        }
        console.error("clean-install-check: PASSED");
        return;
    }
    if (spec.kind === "prebuilt-tarball") {
        console.error(`clean-install-check: validating prebuilt tarball ${spec.spec}`);
        const prebuilt = await runPrebuiltTarballCheck({
            tarballPath: spec.spec,
            log: (m) => console.error(m),
        });
        console.log(formatCleanInstallReport(prebuilt));
        if (!prebuilt.ok) {
            console.error("clean-install-check: FAILED");
            process.exit(1);
        }
        console.error("clean-install-check: PASSED");
        return;
    }
    console.error(`clean-install-check: installing explicit spec ${spec.spec}${allowScripts ? " (allow-scripts)" : ""}`);
    const report = await defaultCleanInstallCheck(spec.spec, {
        allowInstallScripts: allowScripts,
        cleanup: !keep,
    });
    console.log(formatCleanInstallReport(report));
    if (!report.ok) {
        console.error("clean-install-check: FAILED");
        process.exit(1);
    }
    console.error("clean-install-check: PASSED");
}
await main();
//# sourceMappingURL=clean-install-check.js.map