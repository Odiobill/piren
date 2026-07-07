import { describe, expect, it } from "vitest";
import { buildOkfGraph } from "../src/okf-graph.js";
import type { VaultDirReader } from "../src/okf.js";

/** Build an in-memory vault from a { relativePath: content } map. */
function fakeReader(files: Record<string, string>): VaultDirReader {
  const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
  return {
    async list(path: string) {
      const seen = new Set<string>();
      const out: { name: string; isDirectory: boolean }[] = [];
      for (const { path: filePath } of entries) {
        let rel: string | null;
        if (path === "") {
          rel = filePath;
        } else if (filePath === path) {
          continue;
        } else if (filePath.startsWith(path + "/")) {
          rel = filePath.slice(path.length + 1);
        } else {
          continue;
        }
        const segment = rel.split("/")[0]!;
        if (seen.has(segment)) continue;
        seen.add(segment);
        out.push({ name: segment, isDirectory: rel.includes("/") });
      }
      return out;
    },
    async readFile(path: string) {
      const entry = entries.find((e) => e.path === path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      return entry.content;
    },
  };
}

describe("OKF graph core", () => {
  it("builds read-only graph nodes for all OKF typed documents from the vault root", async () => {
    const graph = await buildOkfGraph({
      root: "",
      reader: fakeReader({
        "wiki/concepts/vault-knowledge.md": [
          "---",
          "type: Concept",
          "title: Vault Knowledge",
          "description: Shared knowledge substrate.",
          "---",
          "",
          "# Vault Knowledge",
          "",
          "Piren keeps knowledge inspectable.",
        ].join("\n"),
        "wiki/entities/pi-coding-agent.md": [
          "---",
          "type: Entity",
          "title: Pi Coding Agent",
          "---",
          "",
          "# Pi Coding Agent",
        ].join("\n"),
        "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md": "---\ntype: ADR\ntitle: ADR-0022\n---\n\n# ADR\n",
      }),
    });

    expect(graph.nodes).toEqual([
      {
        id: "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md",
        path: "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md",
        type: "ADR",
        title: "ADR-0022",
      },
      {
        id: "wiki/concepts/vault-knowledge.md",
        path: "wiki/concepts/vault-knowledge.md",
        type: "Concept",
        title: "Vault Knowledge",
        description: "Shared knowledge substrate.",
      },
      {
        id: "wiki/entities/pi-coding-agent.md",
        path: "wiki/entities/pi-coding-agent.md",
        type: "Entity",
        title: "Pi Coding Agent",
      },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([]);
  });

  it("extracts graph edges from project documents as well as wiki documents", async () => {
    const graph = await buildOkfGraph({
      root: "",
      reader: fakeReader({
        "Projects/GymSync/index.md": [
          "---",
          "type: Project Index",
          "title: GymSync",
          "---",
          "",
          "# GymSync",
          "",
          "See [[SaaS Ownership]] and /wiki/entities/cardano.md.",
        ].join("\n"),
        "wiki/concepts/saas-ownership.md": "---\ntype: Concept\ntitle: SaaS Ownership\n---\n\n# SaaS Ownership\n",
        "wiki/entities/cardano.md": "---\ntype: Entity\ntitle: Cardano\n---\n\n# Cardano\n",
      }),
    });

    expect(graph.edges).toEqual([
      {
        source: "Projects/GymSync/index.md",
        target: "wiki/concepts/saas-ownership.md",
        href: "SaaS Ownership",
        kind: "wikilink",
        external: false,
      },
      {
        source: "Projects/GymSync/index.md",
        target: "wiki/entities/cardano.md",
        href: "/wiki/entities/cardano.md",
        kind: "bundle",
        external: false,
      },
    ]);
  });

  it("extracts directed edges from wikilinks, OKF bundle links, relative markdown links, and external URLs", async () => {
    const graph = await buildOkfGraph({
      root: "",
      reader: fakeReader({
        "wiki/concepts/vault-knowledge.md": [
          "---",
          "type: Concept",
          "title: Vault Knowledge",
          "---",
          "",
          "# Vault Knowledge",
          "",
          "See [[wiki/entities/pi-coding-agent|Pi Coding Agent]], /Projects/Piren/decisions/ADR-0022-open-knowledge-format.md, and [related](./linked-concept.md).",
          "External reference: https://example.com/okf?x=1.",
        ].join("\n"),
        "wiki/concepts/linked-concept.md": "---\ntype: Concept\ntitle: Linked Concept\n---\n\n# Linked\n",
        "wiki/entities/pi-coding-agent.md": "---\ntype: Entity\ntitle: Pi Coding Agent\n---\n\n# Pi\n",
        "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md": "---\ntype: ADR\ntitle: ADR-0022\n---\n\n# ADR\n",
      }),
    });

    expect(graph.edges).toEqual([
      {
        source: "wiki/concepts/vault-knowledge.md",
        target: "wiki/entities/pi-coding-agent.md",
        href: "wiki/entities/pi-coding-agent",
        kind: "wikilink",
        external: false,
      },
      {
        source: "wiki/concepts/vault-knowledge.md",
        target: "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md",
        href: "/Projects/Piren/decisions/ADR-0022-open-knowledge-format.md",
        kind: "bundle",
        external: false,
      },
      {
        source: "wiki/concepts/vault-knowledge.md",
        target: "wiki/concepts/linked-concept.md",
        href: "./linked-concept.md",
        kind: "relative",
        external: false,
      },
      {
        source: "wiki/concepts/vault-knowledge.md",
        target: "https://example.com/okf?x=1",
        href: "https://example.com/okf?x=1",
        kind: "external",
        external: true,
      },
    ]);
  });

  it("excludes operational coordination trees from graph nodes while keeping durable knowledge visible", async () => {
    const graph = await buildOkfGraph({
      root: "",
      reader: fakeReader({
        // Durable knowledge — must remain visible.
        "wiki/concepts/vault-knowledge.md": "---\ntype: Concept\ntitle: Vault Knowledge\n---\n# Vault Knowledge\n",
        "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md": "---\ntype: ADR\ntitle: ADR-0022\n---\n# ADR\n",
        // Operational coordination — must be excluded everywhere.
        "skills/shared-skill/SKILL.md": "---\ntype: Skill\ntitle: Shared Skill\n---\n# Shared Skill\n",
        "skills/loose-skill.md": "---\ntype: Skill\ntitle: Loose Skill\n---\n# Loose Skill\n",
        "team/zai/skills/agent-skill/SKILL.md": "---\ntype: Skill\ntitle: Agent Skill\n---\n# Agent Skill\n",
        "team/zai/inbox/do-thing.md": "---\ntype: Task\ntitle: Do Thing\n---\n# Task\n",
        "team/zai/inbox/task.claimed.laptop.md": "---\ntype: Task\ntitle: Claimed Task\n---\n# Task\n",
        "team/zai/cron/jobs/nightly.md": "---\ntype: Cron Job\ntitle: Nightly\n---\n# Job\n",
        "team/zai/cron/runs/run-1.md": "---\ntype: Cron Run\ntitle: Run 1\n---\n# Run\n",
        "team/zai/sessions/2026-07-07.md": "---\ntype: Session Summary\ntitle: Session\n---\n# Session\n",
        "team/zai/devices/device-notes.md": "---\ntype: Entity\ntitle: Device Notes\n---\n# Device\n",
        "steward-inbox/alerts/ops-alert.md": "---\ntype: Concept\ntitle: Ops Alert\n---\n# Alert\n",
        "cron/jobs/global-job.md": "---\ntype: Cron Job\ntitle: Global Job\n---\n# Global Job\n",
        "cron/runs/global-run.md": "---\ntype: Cron Run\ntitle: Global Run\n---\n# Global Run\n",
        "templates/adr-template.md": "---\ntype: ADR\ntitle: ADR Template\n---\n# Template\n",
        // team/zai/cron/ (not jobs/runs) and team/zai/ itself are not operational roots.
        "team/zai/notes.md": "---\ntype: Concept\ntitle: Zai Notes\n---\n# Notes\n",
        "team/zai/cron/policy.md": "---\ntype: Concept\ntitle: Cron Policy\n---\n# Policy\n",
      }),
    });

    expect(graph.nodes.map((n) => n.path)).toEqual([
      "Projects/Piren/decisions/ADR-0022-open-knowledge-format.md",
      "team/zai/cron/policy.md",
      "team/zai/notes.md",
      "wiki/concepts/vault-knowledge.md",
    ]);
  });

  it("drops edges that point at excluded operational files, leaving no dangling operational links", async () => {
    const graph = await buildOkfGraph({
      root: "",
      reader: fakeReader({
        "wiki/concepts/vault-knowledge.md": [
          "---",
          "type: Concept",
          "title: Vault Knowledge",
          "---",
          "",
          "# Vault Knowledge",
          "",
          "Operational refs by path: /team/zai/inbox/do-thing.md, /skills/shared-skill/SKILL.md, /cron/jobs/global-job.md, /steward-inbox/alerts/ops-alert.md.",
        ].join("\n"),
        "skills/shared-skill/SKILL.md": "---\ntype: Skill\ntitle: Shared Skill\n---\n# Shared Skill\n",
        "team/zai/inbox/do-thing.md": "---\ntype: Task\ntitle: Do Thing\n---\n# Task\n",
        "cron/jobs/global-job.md": "---\ntype: Cron Job\ntitle: Global Job\n---\n# Job\n",
        "steward-inbox/alerts/ops-alert.md": "---\ntype: Concept\ntitle: Ops Alert\n---\n# Alert\n",
      }),
    });

    // Only the durable source node exists; every linked target is operational and excluded.
    expect(graph.nodes.map((n) => n.path)).toEqual(["wiki/concepts/vault-knowledge.md"]);
    expect(graph.edges).toEqual([]);
  });

  it("keeps durable wiki/project links intact when operational files are present alongside them", async () => {
    const graph = await buildOkfGraph({
      root: "",
      reader: fakeReader({
        "Projects/GymSync/index.md": [
          "---",
          "type: Project Index",
          "title: GymSync",
          "---",
          "",
          "# GymSync",
          "",
          "See [[SaaS Ownership]] and /team/zai/inbox/noise.md.",
        ].join("\n"),
        "wiki/concepts/saas-ownership.md": "---\ntype: Concept\ntitle: SaaS Ownership\n---\n# SaaS Ownership\n",
        "team/zai/inbox/noise.md": "---\ntype: Task\ntitle: Noise\n---\n# Noise\n",
      }),
    });

    expect(graph.nodes.map((n) => n.path)).toEqual([
      "Projects/GymSync/index.md",
      "wiki/concepts/saas-ownership.md",
    ]);
    // Durable wikilink is preserved; operational path link is dropped.
    expect(graph.edges).toEqual([
      {
        source: "Projects/GymSync/index.md",
        target: "wiki/concepts/saas-ownership.md",
        href: "SaaS Ownership",
        kind: "wikilink",
        external: false,
      },
    ]);
  });

  it("deduplicates repeated links and reports unreadable files without mutating the vault", async () => {
    const reader: VaultDirReader = {
      async list(path: string) {
        if (path === "") return [{ name: "wiki", isDirectory: true }];
        if (path === "wiki") return [{ name: "concepts", isDirectory: true }];
        if (path === "wiki/concepts") {
          return [
            { name: "source.md", isDirectory: false },
            { name: "unreadable.md", isDirectory: false },
          ];
        }
        return [];
      },
      async readFile(path: string) {
        if (path === "wiki/concepts/unreadable.md") throw new Error("ENOENT");
        return [
          "---",
          "type: Concept",
          "title: Source",
          "---",
          "",
          "# Source",
          "",
          "[[Source]] [[Source]]",
        ].join("\n");
      },
    };

    const graph = await buildOkfGraph({ root: "", reader });

    expect(graph.edges).toEqual([
      {
        source: "wiki/concepts/source.md",
        target: "wiki/concepts/source.md",
        href: "Source",
        kind: "wikilink",
        external: false,
      },
    ]);
    expect(graph.problems).toEqual([
      expect.objectContaining({ path: "wiki/concepts/unreadable.md", kind: "unreadable" }),
    ]);
  });
});
