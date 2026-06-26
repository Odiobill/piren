#!/usr/bin/env node
const { cpSync, existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const packageRoot = resolve(dirname(fileURLToPath(`file://${__filename}`)), "..");

function sanitizedEnv(extra = {}) {
  const env = { ...process.env };

  // During `npm install -g github:user/repo`, npm runs this prepare script from a
  // temporary git clone while the outer global install is still reifying the
  // target prefix. If a nested npm command inherits that prefix/global state,
  // npm can try to mutate the outer package directory from inside prepare.
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "prefix" ||
      normalized === "npm_config_prefix" ||
      normalized === "npm_config_global" ||
      normalized === "npm_config_location" ||
      normalized.startsWith("npm_package_") ||
      normalized.startsWith("npm_lifecycle_")
    ) {
      delete env[key];
    }
  }

  return { ...env, ...extra };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: sanitizedEnv(),
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function copyPublic() {
  cpSync(join(packageRoot, "public"), join(packageRoot, "dist", "public"), { recursive: true });
}

const tscBin = process.platform === "win32" ? join(packageRoot, "node_modules", ".bin", "tsc.cmd") : join(packageRoot, "node_modules", ".bin", "tsc");

if (existsSync(tscBin) && process.env.PIREN_FORCE_NPX_BUILD !== "1") {
  run("npm", ["run", "build"]);
} else {
  const typeRoot = mkdtempSync(join(tmpdir(), "piren-prepare-types-"));
  try {
    run("npm", [
      "install",
      "--prefix",
      typeRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "typescript@^5.9.3",
      "@types/node@^24.10.1",
    ]);
    const tempTsc = process.platform === "win32" ? join(typeRoot, "node_modules", ".bin", "tsc.cmd") : join(typeRoot, "node_modules", ".bin", "tsc");
    run(tempTsc, [
      "-p",
      "tsconfig.build.json",
      "--typeRoots",
      join(typeRoot, "node_modules", "@types"),
    ]);
    copyPublic();
  } finally {
    rmSync(typeRoot, { recursive: true, force: true });
  }
}
