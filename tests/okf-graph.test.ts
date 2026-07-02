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
