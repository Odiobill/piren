import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

let schedulerDocs = "";

beforeAll(async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  schedulerDocs = await readFile(join(repoRoot, "docs", "scheduler.md"), "utf8");
});

describe("docs/scheduler.md — effective-policy report", () => {
  it("documents the report's resolved count-only class scope and warnings without exposing configured names", () => {
    expect(schedulerDocs).toMatch(/--report.{0,500}effective policy|effective policy.{0,500}--report/is);
    expect(schedulerDocs).toContain("agent scope:");
    expect(schedulerDocs).toMatch(/count-only/i);
    expect(schedulerDocs).toMatch(/warnings/i);
    expect(schedulerDocs).toContain("It never prints configured allow/exclude names or raw local config.");
  });
});
