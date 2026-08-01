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
});
