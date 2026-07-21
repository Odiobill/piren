import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStewardAlert } from "../src/alerts.js";
import { checkOkfConceptDocument } from "../src/okf.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piren-alerts-"));
  vault = join(root, "vault");
  await mkdir(join(vault, "steward-inbox", "alerts"), { recursive: true });
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("Phase 2 steward alerts", () => {
  it("creates one authoritative Markdown alert file under steward-inbox/alerts", async () => {
    const result = await createStewardAlert({
      vaultRoot: vault,
      from: "thor",
      title: "Vault unavailable",
      body: "Thor cannot reach the NAS vault and is using cached context only.",
      severity: "high",
      notify: true,
      now: () => new Date("2026-06-23T10:15:00.000Z"),
    });

    expect(result.path).toBe("steward-inbox/alerts/20260623T101500000Z-vault-unavailable.md");
    expect(result.alertId).toBe("20260623T101500000Z-vault-unavailable");
    expect(result.from).toBe("thor");
    expect(result.severity).toBe("high");
    expect(result.status).toBe("open");
    expect(result.notify).toBe(true);
    expect(result.created).toBe("2026-06-23T10:15:00.000Z");
    expect(result.bytes).toBeGreaterThan(0);

    const content = await readFile(join(vault, result.path), "utf8");
    expect(content).toContain("id: 20260623T101500000Z-vault-unavailable");
    expect(content).toContain("from: thor");
    expect(content).toContain("severity: high");
    expect(content).toContain("status: open");
    expect(content).toContain("created: 2026-06-23T10:15:00.000Z");
    expect(content).toContain("notify: true");
    expect(content).toContain("# Vault unavailable");
    expect(content).toContain("Thor cannot reach the NAS vault");
  });

  it("renders a non-empty OKF `type` field in the alert frontmatter", async () => {
    const result = await createStewardAlert({
      vaultRoot: vault,
      from: "thor",
      title: "Vault unavailable",
      body: "Cached context only.",
      now: () => new Date("2026-06-23T10:15:00.000Z"),
    });

    const content = await readFile(join(vault, result.path), "utf8");
    // `type` must be the first frontmatter field and non-empty (ADR-0022 / OKF v0.1).
    expect(content).toMatch(/^---\ntype: Alert\n/);
  });

  it("produces an alert accepted by the OKF conformance core", async () => {
    const result = await createStewardAlert({
      vaultRoot: vault,
      from: "thor",
      title: "Vault unavailable",
      body: "Cached context only.",
      now: () => new Date("2026-06-23T10:15:00.000Z"),
    });

    const content = await readFile(join(vault, result.path), "utf8");
    const check = checkOkfConceptDocument(result.path, content);
    expect(check.ok).toBe(true);
    expect(check.type).toBe("Alert");
    expect(check.problems).toEqual([]);
  });
});
