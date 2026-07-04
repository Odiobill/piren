import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseGroupConfigs,
  resolveAgentGroups,
  resolveFallbackCandidates,
  recommendFallback,
  type FallbackRecommendation,
} from "../src/agent-groups.js";

async function makeVault(): Promise<{ vault: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "piren-agent-groups-"));
  const vault = join(root, "vault");
  return {
    vault,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeGroupConfig(
  vault: string,
  group: string,
  yaml: string,
): Promise<void> {
  const dir = join(vault, "agent-groups", group);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yml"), yaml, "utf8");
}

describe("parseGroupConfigs", () => {
  it("returns an empty map when agent-groups/ does not exist", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const groups = await parseGroupConfigs(vault);
      expect(groups.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("parses a single group config with agents and fallback_order", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "  - sam",
          "fallback_order:",
          "  zai:",
          "    - dipu",
          "    - sam",
          "  dipu:",
          "    - zai",
        ].join("\n"),
      );
      const groups = await parseGroupConfigs(vault);
      expect(groups.size).toBe(1);
      const dev = groups.get("developers");
      expect(dev).toBeDefined();
      expect(dev?.agents).toEqual(["dipu", "zai", "sam"]);
      expect(dev?.fallback_order).toEqual({
        zai: ["dipu", "sam"],
        dipu: ["zai"],
      });
    } finally {
      await cleanup();
    }
  });

  it("parses multiple groups preserving each group name", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu", "  - zai"].join("\n"),
      );
      await writeGroupConfig(
        vault,
        "reviewers",
        ["agents:", "  - sam", "  - dario"].join("\n"),
      );
      const groups = await parseGroupConfigs(vault);
      expect(groups.size).toBe(2);
      expect([...groups.keys()].sort()).toEqual(["developers", "reviewers"]);
      expect(groups.get("developers")?.agents).toEqual(["dipu", "zai"]);
      expect(groups.get("reviewers")?.agents).toEqual(["sam", "dario"]);
    } finally {
      await cleanup();
    }
  });

  it("skips a group directory that has no config.yml (not an error)", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      // A group dir with skills/ but no config.yml
      await mkdir(join(vault, "agent-groups", "developers", "skills"), {
        recursive: true,
      });
      await writeGroupConfig(
        vault,
        "reviewers",
        ["agents:", "  - sam"].join("\n"),
      );
      const groups = await parseGroupConfigs(vault);
      expect(groups.size).toBe(1);
      expect(groups.has("developers")).toBe(false);
      expect(groups.get("reviewers")?.agents).toEqual(["sam"]);
    } finally {
      await cleanup();
    }
  });

  it("throws a clear error on malformed YAML in a group config", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu", "  - zai", "  bad: : : indent"].join("\n"),
      );
      // Hard guarantee: the parser surfaces a thrown error for malformed YAML.
      await expect(parseGroupConfigs(vault)).rejects.toThrow(/developers/);
    } finally {
      await cleanup();
    }
  });

  it("treats missing agents list as empty and missing fallback_order as empty map", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(vault, "developers", ["fallback_order: {}"].join("\n"));
      const groups = await parseGroupConfigs(vault);
      const dev = groups.get("developers");
      expect(dev?.agents).toEqual([]);
      expect(dev?.fallback_order).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it("ignores dotfile and non-directory entries in agent-groups/", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await mkdir(join(vault, "agent-groups"), { recursive: true });
      await writeFile(join(vault, "agent-groups", ".hidden"), "x", "utf8");
      await writeFile(join(vault, "agent-groups", "README.md"), "x", "utf8");
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu"].join("\n"),
      );
      const groups = await parseGroupConfigs(vault);
      expect([...groups.keys()]).toEqual(["developers"]);
    } finally {
      await cleanup();
    }
  });
});

describe("resolveAgentGroups", () => {
  it("returns the names of groups an agent belongs to", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu", "  - zai", "  - sam"].join("\n"),
      );
      await writeGroupConfig(
        vault,
        "reviewers",
        ["agents:", "  - sam", "  - dario"].join("\n"),
      );
      expect(await resolveAgentGroups(vault, "zai")).toEqual(["developers"]);
      expect(await resolveAgentGroups(vault, "sam").then((g) => g.sort())).toEqual([
        "developers",
        "reviewers",
      ]);
      expect(await resolveAgentGroups(vault, "nobody")).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns empty list when agent-groups/ is missing", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      expect(await resolveAgentGroups(vault, "zai")).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("resolveFallbackCandidates", () => {
  it("returns fallback_order candidates filtered by allowed and excluded", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "  - sam",
          "  - dario",
          "fallback_order:",
          "  zai:",
          "    - dipu",
          "    - sam",
          "    - dario",
        ].join("\n"),
      );
      const candidates = await resolveFallbackCandidates(
        vault,
        "zai",
        ["dipu", "sam", "dario"],
        [],
      );
      expect(candidates).toEqual(["dipu", "sam", "dario"]);
    } finally {
      await cleanup();
    }
  });

  it("excludes agents in excluded_agents and not in allowed_agents", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "  - sam",
          "  - dario",
          "fallback_order:",
          "  zai:",
          "    - dipu",
          "    - sam",
          "    - dario",
        ].join("\n"),
      );
      // dario excluded, sam not in allowed list
      const candidates = await resolveFallbackCandidates(
        vault,
        "zai",
        ["dipu"],
        ["dario"],
      );
      expect(candidates).toEqual(["dipu"]);
    } finally {
      await cleanup();
    }
  });

  it("deduplicates candidates across multiple groups preserving first occurrence", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "fallback_order:",
          "  zai:",
          "    - dipu",
        ].join("\n"),
      );
      await writeGroupConfig(
        vault,
        "reviewers",
        [
          "agents:",
          "  - sam",
          "  - zai",
          "fallback_order:",
          "  zai:",
          "    - sam",
          "    - dipu",
        ].join("\n"),
      );
      const candidates = await resolveFallbackCandidates(
        vault,
        "zai",
        ["dipu", "sam"],
        [],
      );
      expect(candidates).toEqual(["dipu", "sam"]);
    } finally {
      await cleanup();
    }
  });

  it("returns empty list when agent has no fallback_order", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu", "  - zai"].join("\n"),
      );
      const candidates = await resolveFallbackCandidates(
        vault,
        "dipu",
        ["zai"],
        [],
      );
      expect(candidates).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns empty list when agent-groups/ is missing", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const candidates = await resolveFallbackCandidates(
        vault,
        "zai",
        ["dipu"],
        [],
      );
      expect(candidates).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("recommendFallback", () => {
  it("returns candidates with their source groups", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "  - sam",
          "fallback_order:",
          "  zai:",
          "    - dipu",
          "    - sam",
        ].join("\n"),
      );
      const result = await recommendFallback(
        vault,
        "zai",
        ["dipu", "sam"],
        [],
      );
      expect(result).toEqual([
        { agent: "dipu", sourceGroups: ["developers"] },
        { agent: "sam", sourceGroups: ["developers"] },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("filters candidates by allowed and excluded agents", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "  - sam",
          "  - dario",
          "fallback_order:",
          "  zai:",
          "    - dipu",
          "    - sam",
          "    - dario",
        ].join("\n"),
      );
      // dario excluded, sam not in allowed
      const result = await recommendFallback(
        vault,
        "zai",
        ["dipu"],
        ["dario"],
      );
      expect(result).toEqual([
        { agent: "dipu", sourceGroups: ["developers"] },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("merges sourceGroups when a candidate appears in multiple groups", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "fallback_order:",
          "  zai:",
          "    - dipu",
        ].join("\n"),
      );
      await writeGroupConfig(
        vault,
        "reviewers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "fallback_order:",
          "  zai:",
          "    - dipu",
        ].join("\n"),
      );
      const result = await recommendFallback(
        vault,
        "zai",
        ["dipu"],
        [],
      );
      expect(result).toEqual([
        { agent: "dipu", sourceGroups: ["developers", "reviewers"] },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("preserves first-encounter order and deduplicates by agent", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - dipu",
          "  - zai",
          "  - sam",
          "fallback_order:",
          "  zai:",
          "    - dipu",
          "    - sam",
        ].join("\n"),
      );
      await writeGroupConfig(
        vault,
        "reviewers",
        [
          "agents:",
          "  - zai",
          "  - sam",
          "fallback_order:",
          "  zai:",
          "    - sam",
        ].join("\n"),
      );
      const result = await recommendFallback(
        vault,
        "zai",
        ["dipu", "sam"],
        [],
      );
      expect(result).toEqual([
        { agent: "dipu", sourceGroups: ["developers"] },
        { agent: "sam", sourceGroups: ["developers", "reviewers"] },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("returns an empty array when the agent has no fallback_order in any group", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu", "  - zai"].join("\n"),
      );
      const result = await recommendFallback(
        vault,
        "dipu",
        ["zai"],
        [],
      );
      expect(result).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns an empty array when agent-groups/ is missing", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      const result = await recommendFallback(
        vault,
        "zai",
        ["dipu"],
        [],
      );
      expect(result).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns an empty array when the agent belongs to no groups", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        ["agents:", "  - dipu", "  - sam"].join("\n"),
      );
      const result = await recommendFallback(
        vault,
        "zai",
        ["dipu", "sam"],
        [],
      );
      expect(result).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("skips self-references in fallback_order", async () => {
    const { vault, cleanup } = await makeVault();
    try {
      await writeGroupConfig(
        vault,
        "developers",
        [
          "agents:",
          "  - zai",
          "  - dipu",
          "fallback_order:",
          "  zai:",
          "    - zai",
          "    - dipu",
        ].join("\n"),
      );
      const result = await recommendFallback(
        vault,
        "zai",
        ["zai", "dipu"],
        [],
      );
      expect(result).toEqual([
        { agent: "dipu", sourceGroups: ["developers"] },
      ]);
    } finally {
      await cleanup();
    }
  });
});
