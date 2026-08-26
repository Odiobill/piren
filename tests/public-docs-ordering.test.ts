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
    expect(
      indexes[i],
      `${file}: "${anchors[i]}" must appear after "${anchors[i - 1]}"`,
    ).toBeGreaterThan(indexes[i - 1]);
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
});
