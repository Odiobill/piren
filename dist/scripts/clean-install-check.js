#!/usr/bin/env tsx
/**
 * Piren clean-install validation.
 *
 * Installs Piren from a package spec (default: the real github repo) into an
 * isolated clean HOME and prefix, then verifies the installed binary:
 *
 *   1. dist/src/cli.js, dist/public/index.html, dist/src/pi-extension.js exist
 *      (catches failed git-install prepare builds).
 *   2. The installed piren binary actually runs.
 *   3. The Pi runtime policy resolves: pi on PATH preferred, otherwise the
 *      explicit npx --yes -p @earendil-works/pi-coding-agent@latest pi fallback.
 *
 * Usage:
 *   npm run clean-install:check
 *   npm run clean-install:check -- github:Odiobill/piren
 *   npm run clean-install:check -- /path/to/piren-0.1.0.tgz --allow-scripts
 *
 * The script exits non-zero on any FAIL check, so it is CI-safe.
 */
import { defaultCleanInstallCheck, formatCleanInstallReport } from "../src/clean-install.js";
async function main() {
    const args = process.argv.slice(2);
    const spec = args.find((a) => !a.startsWith("--")) ?? "github:Odiobill/piren";
    const allowScripts = args.includes("--allow-scripts");
    const keep = args.includes("--keep");
    console.error(`clean-install-check: installing ${spec}${allowScripts ? " (allow-scripts)" : ""}`);
    const report = await defaultCleanInstallCheck(spec, {
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