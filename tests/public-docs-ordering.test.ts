import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

/**
 * R3 preferred-path ordering regression.
 *
 * Configuration guidance is user-first and easiest-first: where several paths
 * exist, documentation presents them in this order:
 *
 *   Workbench Settings -> guided CLI -> CLI commands -> manual YAML
 *
 * with the natural first-install prerequisite stated plainly (a new user runs
 * `piren setup` before a configured gateway and its Settings UI exist).
 *
 * The assertions are deliberately narrow heading/anchor order checks so an
 * accidental reorder back to manual-first fails loudly. They do not pin exact
 * prose wording.
 */
function expectAnchorOrder(content: string, file: string, anchors: string[]): void {
  const indexes = anchors.map((anchor) => {
    const index = content.indexOf(anchor);
    expect(index, `${file}: anchor not found: ${anchor}`).toBeGreaterThan(-1);
    return index;
  });
  for (let i = 1; i < indexes.length; i++) {
    const current = indexes[i]!;
    const previous = indexes[i - 1]!;
    expect(
      current,
      `${file}: "${anchors[i]}" must appear after "${anchors[i - 1]}"`,
    ).toBeGreaterThan(previous);
  }
}

describe("public documentation preferred-path ordering", () => {
  it("getting-started presents interactive setup before scripted setup before manual config", () => {
    expectAnchorOrder(read("docs/getting-started.md"), "docs/getting-started.md", [
      "### Interactive first-run setup",
      "### Scripted setup",
      "### Manual local config",
    ]);
  });

  it("agent-groups presents Workbench Settings before piren group commands before manual YAML", () => {
    expectAnchorOrder(read("docs/agent-groups.md"), "docs/agent-groups.md", [
      "### Manage groups in the Workbench",
      "### Manage groups with the `piren group` command",
      "### Group configuration reference",
    ]);
  });

  it("agent-groups shows the exact valid group fallback command syntax", () => {
    // Real syntax: piren group fallback set <group> <agent> <candidate...>
    expect(read("docs/agent-groups.md")).toContain(
      "piren group fallback set research reviewer analyst writer",
    );
  });

  it("scheduler presents the Workbench tab, then guided configure, then raw YAML reference", () => {
    expectAnchorOrder(read("docs/scheduler.md"), "docs/scheduler.md", [
      "Scheduler tab of the Settings module",
      "is an interactive, guided writer",
      "## Local scheduler config",
    ]);
  });

  it("configuration gives model fallback a titled subsection with a per-surface table", () => {
    const doc = read("docs/configuration.md");
    expect(doc).toContain("### Model fallback");
    // Every delivered run surface is covered by the table.
    for (const row of [
      "Gateway chat",
      "OpenAI-compatible API",
      "Conversations",
      "Telegram and Discord transports",
      "`piren ask`",
      "Scheduler claimed inbox tasks and agent cron",
      "Script-mode cron",
      "`piren run`",
    ]) {
      expect(doc, `missing surface row: ${row}`).toContain(row);
    }
    const section = doc.slice(doc.indexOf("### Model fallback"));
    expect(section).toContain("Not wired"); // script-mode cron remains LLM-free
    expect(section).toContain("`piren run` and `piren chat` | Wired locally");
    expect(section).toContain("manual recovery");
  });

  it("configuration opens with a Where do I change X matrix and pins no-UI boundaries", () => {
    const doc = read("docs/configuration.md");
    expect(doc).toContain("## Where do I change X?");
    const matrix = doc.slice(
      doc.indexOf("## Where do I change X?"),
      doc.indexOf("## Local installation config"),
    );
    // Preferred-path ordering: Settings first where it exists, then guided
    // CLI, then manual reference.
    for (const anchor of [
      "Workbench Settings",
      "piren scheduler configure",
      "piren telegram configure",
      "piren group",
    ]) {
      expect(matrix, `matrix missing: ${anchor}`).toContain(anchor);
    }
    // Critical no-UI boundaries.
    expect(matrix).toContain("not editable from Workbench Settings");
    expect(matrix).toContain("CLI only");
    expect(matrix).toContain("browser never reads or edits");
    expect(matrix).toContain("Pi-native");
    // Every applicable row links to its detailed section/page.
    for (const link of [
      "(getting-started.md#configure-the-local-installation)",
      "(#transport-config)",
      "(#scheduler-config)",
      "(#agent-local-config)",
      "(agent-groups.md)",
      "(service-management.md)",
      "(getting-started.md#configure-pi)",
      "(#workbench-config-workbenchyml)",
    ]) {
      expect(matrix, `matrix missing link: ${link}`).toContain(link);
    }
  });
});
