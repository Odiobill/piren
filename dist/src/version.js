/**
 * Version reporting for the Piren CLI.
 *
 * Separated from src/cli.ts so the version read is a pure, unit-testable
 * core function: `readVersion(packageJsonPath)` reads the `version` field from
 * a package.json path and returns it, or `"unknown"` if the file is missing,
 * unparseable, or has no version field.
 *
 * The CLI `piren version` command prints this value. This lets a released
 * binary self-report its version without hardcoding it (which drifts from
 * package.json) and gives the clean-install check a real version subcommand
 * to probe instead of reaching into package.json directly.
 */
import { readFileSync } from "node:fs";
export function readVersion(packageJsonPath) {
    try {
        const text = readFileSync(packageJsonPath, "utf8");
        const pkg = JSON.parse(text);
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
            return pkg.version;
        }
        return "unknown";
    }
    catch {
        return "unknown";
    }
}
//# sourceMappingURL=version.js.map