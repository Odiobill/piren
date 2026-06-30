import { describe, expect, it } from "vitest";
import { formatHelp, formatCommandHelp, isHelpRequest, HELP_TOPICS } from "../src/help.js";

describe("help: help detection", () => {
  it("recognizes -h and --help as a help request", () => {
    expect(isHelpRequest(["-h"])).toBe(true);
    expect(isHelpRequest(["--help"])).toBe(true);
  });

  it("returns false when no help flag is present", () => {
    expect(isHelpRequest([])).toBe(false);
    expect(isHelpRequest(["status"])).toBe(false);
    expect(isHelpRequest(["--force"])).toBe(false);
  });

  it("ignores --help that appears after the -- passthrough separator", () => {
    // piren run -- --help must forward --help to Pi, not show Piren help.
    expect(isHelpRequest(["run", "--", "--help"])).toBe(false);
  });
});

describe("help: top-level help", () => {
  it("lists every known command", () => {
    const text = formatHelp();
    for (const command of HELP_TOPICS) {
      expect(text).toContain(command.command);
    }
  });

  it("includes the version line", () => {
    expect(formatHelp()).toContain("version");
  });

  it("includes the update command", () => {
    expect(formatHelp()).toContain("update");
    expect(formatCommandHelp("update")).toContain("github:Odiobill/piren");
  });

  it("mentions global flags", () => {
    const text = formatHelp();
    expect(text).toContain("--vault-root");
    expect(text).toContain("--agent");
  });
});

describe("help: per-command help", () => {
  it("prints usage and an example for run", () => {
    const text = formatCommandHelp("run");
    expect(text).toContain("piren run");
    expect(text).toMatch(/example/i);
  });

  it("prints usage and an example for gateway", () => {
    const text = formatCommandHelp("gateway");
    expect(text).toContain("piren gateway");
    expect(text).toContain("--port");
    expect(text).toContain("--host");
  });

  it("prints usage and an example for setup", () => {
    const text = formatCommandHelp("setup");
    expect(text).toContain("piren setup");
    expect(text).toContain("--apply");
  });

  it("prints usage and an example for service", () => {
    const text = formatCommandHelp("service");
    expect(text).toContain("piren service");
    expect(text).toContain("install");
    expect(text).toContain("remove");
    expect(text).toContain("start");
    expect(text).toContain("stop");
  });

  it("prints usage and an example for clean", () => {
    const text = formatCommandHelp("clean");
    expect(text).toContain("piren clean");
    expect(text).toContain("--force");
  });

  it("returns a generic unknown-command message for unrecognized commands", () => {
    const text = formatCommandHelp("bogus");
    expect(text).toContain("Unknown command");
    expect(text).toContain("bogus");
  });
});
