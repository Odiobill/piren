import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectStatus, projectAppendLog, decisionRecord } from "../src/knowledge.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-knowledge-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "Projects", "Piren", "decisions"), { recursive: true });
  await writeFile(join(vault, ".piren-vault"), "");
});

afterEach(async () => rm(root, { recursive: true, force: true }));

async function writeProjectIndex(status: string): Promise<void> {
  await writeFile(
    join(vault, "Projects", "Piren", "index.md"),
    [
      "---",
      'title: "Piren Project Index"',
      "created: 2026-06-21",
      "updated: 2026-06-24",
      "tags: [piren, project]",
      `status: ${status}`,
      "---",
      "",
      "# Piren Project Index",
      "",
      "Piren is a lightweight agent platform.",
    ].join("\n"),
  );
}

describe("Phase 4 knowledge lifecycle: project_status", () => {
  it("reads project title and status from index.md frontmatter", async () => {
    await writeProjectIndex("phase-4-knowledge");
    const result = await projectStatus({ vaultRoot: vault, project: "Piren" });

    expect(result.project).toBe("Piren");
    expect(result.path).toBe("Projects/Piren/index.md");
    expect(result.title).toBe("Piren Project Index");
    expect(result.status).toBe("phase-4-knowledge");
    expect(result.updated).toBe("2026-06-24");
    expect(result.available).toBe(true);
  });

  it("reports available:false when the project index does not exist", async () => {
    const result = await projectStatus({ vaultRoot: vault, project: "Missing" });

    expect(result.available).toBe(false);
    expect(result.project).toBe("Missing");
    expect(result.status).toBe("");
  });

  it("rejects project names that traverse outside the vault", async () => {
    await expect(projectStatus({ vaultRoot: vault, project: "../outside" })).rejects.toThrow(/invalid project name/i);
  });
});

describe("Phase 4 knowledge lifecycle: project_append_log", () => {
  it("appends a timestamped Markdown entry to a project log.md", async () => {
    const result = await projectAppendLog({
      vaultRoot: vault,
      project: "Piren",
      entry: "Implemented project_status knowledge tool.",
      agentName: "thor",
      now: () => new Date("2026-06-25T09:30:00.000Z"),
    });

    expect(result.path).toBe("Projects/Piren/log.md");
    expect(result.timestamp).toBe("2026-06-25T09:30:00.000Z");
    expect(result.bytesAppended).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);

    const content = await readFile(join(vault, "Projects", "Piren", "log.md"), "utf8");
    expect(content).toContain("## 2026-06-25T09:30:00.000Z");
    expect(content).toContain("Implemented project_status knowledge tool.");
    expect(content).toContain("agent: thor");
  });

  it("appends to an existing log.md without overwriting prior entries", async () => {
    await writeFile(
      join(vault, "Projects", "Piren", "log.md"),
      "## 2026-06-24T08:00:00.000Z\nFirst entry.\n",
    );

    await projectAppendLog({
      vaultRoot: vault,
      project: "Piren",
      entry: "Second entry.",
      now: () => new Date("2026-06-25T10:00:00.000Z"),
    });

    const content = await readFile(join(vault, "Projects", "Piren", "log.md"), "utf8");
    expect(content).toContain("First entry.");
    expect(content).toContain("Second entry.");
  });

  it("rejects an empty entry", async () => {
    await expect(
      projectAppendLog({ vaultRoot: vault, project: "Piren", entry: "   " }),
    ).rejects.toThrow(/entry is required/i);
  });
});

describe("Phase 4 knowledge lifecycle: decision_record", () => {
  it("writes an ADR file under Projects/<project>/decisions/", async () => {
    const result = await decisionRecord({
      vaultRoot: vault,
      project: "Piren",
      id: "0015",
      title: "Knowledge Lifecycle Tools",
      context: "Agents need explicit tools to leave durable artifacts.",
      decision: "Add project_status, project_append_log, and decision_record as vault tools.",
      consequences: "Agents can promote task lessons into project logs and ADRs.",
      alternatives: "Rely on ad-hoc vault_write for all artifacts.",
      now: () => new Date("2026-06-25T11:00:00.000Z"),
    });

    expect(result.path).toBe("Projects/Piren/decisions/ADR-0015-knowledge-lifecycle-tools.md");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.created).toBe("2026-06-25T11:00:00.000Z");

    const content = await readFile(join(vault, "Projects", "Piren", "decisions", "ADR-0015-knowledge-lifecycle-tools.md"), "utf8");
    expect(content).toContain('title: "ADR-0015 - Knowledge Lifecycle Tools"');
    expect(content).toContain("created: 2026-06-25");
    expect(content).toContain("status: accepted");
    expect(content).toContain("# ADR-0015 - Knowledge Lifecycle Tools");
    expect(content).toContain("## Context");
    expect(content).toContain("Agents need explicit tools to leave durable artifacts.");
    expect(content).toContain("## Decision");
    expect(content).toContain("Add project_status, project_append_log, and decision_record");
    expect(content).toContain("## Consequences");
    expect(content).toContain("Agents can promote task lessons into project logs and ADRs.");
    expect(content).toContain("## Alternatives");
    expect(content).toContain("Rely on ad-hoc vault_write for all artifacts.");
  });

  it("writes an ADR without optional consequences and alternatives sections", async () => {
    const result = await decisionRecord({
      vaultRoot: vault,
      project: "Piren",
      id: "0016",
      title: "Minimal ADR",
      context: "Short context.",
      decision: "Short decision.",
      now: () => new Date("2026-06-25T11:00:00.000Z"),
    });

    const content = await readFile(join(vault, result.path), "utf8");
    expect(content).not.toContain("## Consequences");
    expect(content).not.toContain("## Alternatives");
    expect(content).toContain("## Context");
    expect(content).toContain("## Decision");
  });

  it("rejects an invalid ADR id", async () => {
    await expect(
      decisionRecord({
        vaultRoot: vault,
        project: "Piren",
        id: "bad",
        title: "Bad ADR",
        context: "ctx",
        decision: "dec",
      }),
    ).rejects.toThrow(/invalid.*id/i);
  });
});
