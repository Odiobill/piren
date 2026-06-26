#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const packageRoot = resolve(dirname(fileURLToPath(`file://${__filename}`)), "..");

function localNpmEnv() {
  const env = { ...process.env };

  // During `npm install -g github:user/repo`, npm runs this prepare script from a
  // temporary git clone while the outer global install is still reifying the
  // target prefix. If the nested npm install inherits that prefix/global state,
  // npm can try to rename the outer package directory from inside the prepare
  // step and fail with EISDIR. Keep the nested install local to this clone.
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

  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: localNpmEnv(),
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const tscBin = process.platform === "win32" ? join(packageRoot, "node_modules", ".bin", "tsc.cmd") : join(packageRoot, "node_modules", ".bin", "tsc");

if (!existsSync(tscBin)) {
  run("npm", [
    "install",
    "--prefix",
    packageRoot,
    "--include=dev",
    "--include=peer",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
}

run("npm", ["run", "build"]);
