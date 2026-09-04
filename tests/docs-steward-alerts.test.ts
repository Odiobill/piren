import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("public steward-alert documentation", () => {
  it("documents the Workbench alert badge/module and one-way close boundary", () => {
    const gateway = read("docs/gateway.md");
    expect(gateway).toContain("Steward Alerts");
    expect(gateway).toContain("/api/steward-alerts");
    expect(gateway).toContain("Close alert");
    expect(gateway).toContain("not automatically archived");

    const api = read("docs/api.md");
    expect(api).toContain("GET /api/steward-alerts");
    expect(api).toContain("POST /api/steward-alerts/close");
    expect(api).toContain('expected_status: "open"');
  });
});
