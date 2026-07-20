import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  run?: string;
}

interface Job {
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const workflowPath = join(process.cwd(), ".github", "workflows", "oidc-diagnostic.yml");

function runText(job: Job | undefined): string {
  return (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
}

describe("OIDC trusted-publishing diagnostic workflow", () => {
  it("is manual, uses the production environment identity, and logs only selected OIDC claims", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const workflow = parseYaml(raw) as Workflow;
    const jobs = workflow.jobs ?? {};
    const job = jobs.diagnose;
    const script = runText(job);

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(Object.keys(jobs)).toEqual(["diagnose"]);
    expect(job?.environment).toBe("npm-production");
    expect(job?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(script).toContain("npm:registry.npmjs.org");
    expect(script).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(script).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(script).toContain("visibleClaims");
    expect(script).toContain('"repository"');
    expect(script).toContain('"workflow_ref"');
    expect(script).toContain('"environment"');
    expect(script).not.toMatch(/npm\s+publish/);
    expect(script).not.toMatch(/npm\s+install/);
    expect(script).not.toMatch(/console\.log\(.*value/);
    expect(script).not.toMatch(/console\.log\(.*ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  });
});
