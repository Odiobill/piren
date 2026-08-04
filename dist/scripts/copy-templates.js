#!/usr/bin/env node
/**
 * Deterministic copy of the bundled starter-skill templates into dist/templates
 * (S3a §5). Runs as part of `npm run build` so the packed package ships the
 * validated `templates/` tree as `dist/templates/`.
 *
 * The copy is deterministic (mkdir + writeFile, no cp -r) and validates every
 * profile through the S3 core before writing: a template failing the manifest
 * identity/digest contract is a package build error, never shipped.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRealStarterSkillsDeps, listStarterProfiles, parseStarterManifest, validateProfileTemplates, } from "../src/starter-skills.js";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(repoRoot, "templates");
const outDir = join(repoRoot, "dist", "templates");
const deps = createRealStarterSkillsDeps();
// Keep stdout clean: `npm pack --json` runs prepack -> build and parses
// stdout, so any build-time output must go to stderr (same contract as
// vite's `logLevel: "error"`).
const profiles = await listStarterProfiles(deps, templatesDir);
if (profiles.length === 0) {
    console.error(`copy-templates: no starter-skill profiles found under ${templatesDir}`);
    process.exit(1);
}
for (const profile of profiles) {
    const manifestYaml = await deps.readFile(join(templatesDir, profile, "manifest.yml"));
    const manifest = parseStarterManifest(manifestYaml);
    // Fail-closed package build gate: digest drift, missing name/description,
    // or identity mismatch throws here, so nothing invalid is shipped.
    await validateProfileTemplates(deps, templatesDir, manifest);
    await mkdir(join(outDir, profile), { recursive: true });
    await writeFile(join(outDir, profile, "manifest.yml"), manifestYaml);
    for (const entry of manifest.entries) {
        const content = await deps.readFile(join(templatesDir, profile, entry.source));
        const dest = join(outDir, profile, entry.source);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content);
    }
}
console.error(`copy-templates: copied starter-skill profile(s) ${profiles.join(", ")} -> ${outDir}`);
//# sourceMappingURL=copy-templates.js.map