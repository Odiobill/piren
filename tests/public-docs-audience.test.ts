import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function publicDocumentation(): Array<{ path: string; content: string }> {
  const docsDir = join(root, "docs");
  const docs = readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ path: `docs/${name}`, content: read(`docs/${name}`) }));
  return [
    { path: "README.md", content: read("README.md") },
    ...docs,
    { path: "site/index.html", content: read("site/index.html") },
  ];
}

describe("public documentation audience", () => {
  it("keeps numbered vault-development labels out of shipped docs", () => {
    const internalLabels = /\b(?:ADR-\d{4}|[ODS]\d+(?:[–-][A-Z]\d+)?|tracer bullet|release-lane)\b/giu;
    const findings = publicDocumentation().flatMap(({ path, content }) =>
      [...content.matchAll(internalLabels)].map((match) => `${path}: ${match[0]}`),
    );
    expect(findings).toEqual([]);
  });

  it("presents setup and optional messaging configuration as separate real steps", () => {
    const landing = read("site/index.html");
    const gettingStarted = read("docs/getting-started.md");
    for (const content of [landing, gettingStarted]) {
      expect(content).toContain("piren setup");
      expect(content).toContain("piren telegram configure");
      expect(content).toContain("piren discord configure");
    }
    expect(landing).not.toMatch(/choose a Pi provider and API key, select a model, and configure gateways/i);
  });

  it("links the task coordination guide from the main surfaces", () => {
    // R4a discoverability pin: docs/tasks.md is the user-facing home for task
    // coordination and the primary docs surfaces point at it.
    const tasks = read("docs/tasks.md");
    for (const anchor of [
      "piren task send",
      ".claimed.<device>.md",
      "(scheduler.md)",
      "(recovery.md#stuck-inbox-task-claim)",
    ]) {
      expect(tasks).toContain(anchor);
    }
    // R4a correction pins: claim uses a sanitized hostname; --result replaces
    // the task's Result section rather than appending.
    expect(tasks).toContain("sanitized hostname");
    expect(tasks).toContain("replacing any previous result content");
    expect(tasks).not.toContain("appends the file's content");
    expect(tasks).not.toContain("your hostname is used");
    for (const rel of ["README.md", "docs/getting-started.md", "docs/troubleshooting.md", "docs/vault-layout.md"]) {
      expect(read(rel), `${rel} must link docs/tasks.md`).toContain("tasks.md");
    }
  });

  it("documents the peer-audience conversation start on gateway and API surfaces", () => {
    // R4b discoverability/boundary pin: the delivered peer-audience start is
    // documented user-facing with its no-dispatch boundary.
    const gateway = read("docs/gateway.md");
    for (const anchor of [
      "POST /api/conversations/start-peer",
      "dispatches no agent",
      "two to eight locally runnable agents",
    ]) {
      expect(gateway).toContain(anchor);
    }
    const api = read("docs/api.md");
    for (const anchor of [
      "POST /api/conversations/start-peer",
      "not in the local runnable set",
      "201 {conversation, event}",
    ]) {
      expect(api).toContain(anchor);
    }
    // R4b correction pins: mention of an existing audience member dispatches
    // it; only a previously absent runnable agent is added before dispatch.
    for (const doc of [gateway, api]) {
      expect(doc).toContain("dispatches an existing audience member");
      expect(doc).toContain("adds that agent to the audience before dispatch");
    }
  });
});
