#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const tscBin = process.platform === "win32" ? join("node_modules", ".bin", "tsc.cmd") : join("node_modules", ".bin", "tsc");

if (!existsSync(tscBin)) {
  run("npm", ["install", "--include=dev", "--include=peer", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"]);
}

run("npm", ["run", "build"]);
