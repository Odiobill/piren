import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  isLikelyTaskPath,
  assertVaultContained,
  assertInboxTaskRelPath,
  resolveTaskIdOrPath,
  readVaultFile,
  readTaskDetail,
  formatTaskList,
  formatTaskDetail,
  isValidCliPriority,
  CLI_PRIORITIES,
  type TaskCliDeps,
  type TaskListRow,
} from "../src/task-cli.js";

// ---------------------------------------------------------------------------
// Fake filesystem for injected deps. Mirrors the cron-cli/skill-cli test shape
// so the pure task CLI core can be exercised without touching real disk.
// ---------------------------------------------------------------------------

interface FakeEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

class FakeFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  private _entries = new Map<string, FakeEntry[]>();

  constructor() {
    this.dirs.add("");
    this.dirs.add("/");
  }

  private norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private registerParents(p: string): void {
    const parts = p.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length; i += 1) {
      const child = parts[i]!;
      const parent = acc;
      acc += "/" + child;
      this.dirs.add(acc);
      // Register this directory as an entry of its parent so readdir lists
      // intermediate ancestors (not just the immediate parent of a file).
      let entries = this._entries.get(parent) ?? [];
      if (!entries.some((e) => e.name === child)) {
        entries.push({ name: child, isDirectory: () => true, isFile: () => false });
        this._entries.set(parent, entries);
      }
    }
  }

  file(path: string, content: string): this {
    const p = this.norm(path);
    this.files.set(p, content);
    this.registerParents(p);
    const parent = p.substring(0, p.lastIndexOf("/")) || "/";
    const name = p.substring(p.lastIndexOf("/") + 1);
    let entries = this._entries.get(parent) ?? [];
    entries = entries.filter((e) => e.name !== name);
    entries.push({ name, isDirectory: () => false, isFile: () => true });
    this._entries.set(parent, entries);
    return this;
  }

  dir(path: string): this {
    const p = this.norm(path);
    this.dirs.add(p);
    this.registerParents(p);
    const parent = p.substring(0, p.lastIndexOf("/")) || "/";
    const name = p.substring(p.lastIndexOf("/") + 1);
    let entries = this._entries.get(parent) ?? [];
    entries = entries.filter((e) => e.name !== name);
    entries.push({ name, isDirectory: () => true, isFile: () => false });
    this._entries.set(parent, entries);
    return this;
  }

  deps(): TaskCliDeps {
    return {
      readFile: async (p: string) => {
        const norm = this.norm(p);
        if (!this.files.has(norm)) throw new Error(`ENOENT: ${p}`);
        return this.files.get(norm)!;
      },
      stat: async (p: string) => {
        const norm = this.norm(p);
        if (this.files.has(norm)) return { isDirectory: () => false };
        if (this.dirs.has(norm)) return { isDirectory: () => true };
        throw new Error(`ENOENT: ${p}`);
      },
      readdir: async (p: string) => {
        const norm = this.norm(p);
        return this._entries.get(norm) ?? [];
      },
      access: async (p: string) => {
        const norm = this.norm(p);
        if (!this.files.has(norm) && !this.dirs.has(norm)) {
          throw new Error(`ENOENT: ${p}`);
        }
      },
    };
  }
}

const VAULT = "/vault";

function sampleTaskFile(opts: {
  id?: string;
  from?: string;
  to?: string;
  title?: string;
  status?: string;
  priority?: string;
  body?: string;
} = {}): string {
  const id = opts.id ?? "20260622T153000000Z-check-disk-usage";
  const from = opts.from ?? "piren";
  const to = opts.to ?? "thor";
  const title = opts.title ?? "Check disk usage";
  const status = opts.status ?? "pending";
  const priority = opts.priority ?? "normal";
  const body = opts.body ?? "Please check disk usage on the NAS.";
  return [
    "---",
    "type: Task",
    `id: ${id}`,
    `from: ${from}`,
    `to: ${to}`,
    `priority: ${priority}`,
    `status: ${status}`,
    "created: 2026-06-22T15:30:00.000Z",
    "updated: 2026-06-22T15:30:00.000Z",
    "requires_approval: false",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
    "## Result",
    "",
    "Pending.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Heuristic + validation
// ---------------------------------------------------------------------------

describe("task-cli path heuristics", () => {
  it("treats slash-containing or .md-suffixed strings as paths", () => {
    expect(isLikelyTaskPath("team/thor/inbox/foo.md")).toBe(true);
    expect(isLikelyTaskPath("foo.md")).toBe(true);
    expect(isLikelyTaskPath("./foo.md")).toBe(true);
    expect(isLikelyTaskPath("team/thor/inbox/foo.claimed.dev.md")).toBe(true);
  });

  it("treats bare ids without slashes as ids, not paths", () => {
    expect(isLikelyTaskPath("20260622T153000000Z-check-disk-usage")).toBe(false);
    expect(isLikelyTaskPath("nightly-digest")).toBe(false);
  });
});

describe("task-cli vault containment", () => {
  it("accepts a path inside the vault", () => {
    expect(() => assertVaultContained(VAULT, join(VAULT, "team/thor/inbox/foo.md"))).not.toThrow();
  });

  it("rejects traversal outside the vault", () => {
    expect(() => assertVaultContained(VAULT, join(VAULT, "../etc/passwd"))).toThrow(/vault/i);
  });

  it("rejects an absolute path outside the vault", () => {
    expect(() => assertVaultContained(VAULT, "/etc/passwd")).toThrow(/vault/i);
  });
});

describe("task-cli inbox rel-path structure", () => {
  it("parses a valid inbox task path into agent + filename", () => {
    const parsed = assertInboxTaskRelPath(VAULT, "team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
    expect(parsed.agentName).toBe("thor");
    expect(parsed.fileName).toBe("20260622T153000000Z-check-disk-usage.md");
  });

  it("accepts a claimed task path", () => {
    const parsed = assertInboxTaskRelPath(VAULT, "team/thor/inbox/foo.claimed.heimdall.md");
    expect(parsed.agentName).toBe("thor");
  });

  it("rejects a path outside the inbox", () => {
    expect(() => assertInboxTaskRelPath(VAULT, "team/thor/skills/foo.md")).toThrow(/inbox/i);
    expect(() => assertInboxTaskRelPath(VAULT, "wiki/concepts/foo.md")).toThrow(/inbox/i);
  });

  it("rejects traversal in the agent segment", () => {
    expect(() => assertInboxTaskRelPath(VAULT, "team/../etc/inbox/foo.md")).toThrow();
  });

  it("rejects a non-markdown file", () => {
    expect(() => assertInboxTaskRelPath(VAULT, "team/thor/inbox/foo.txt")).toThrow(/markdown|\.md|inbox/i);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskIdOrPath
// ---------------------------------------------------------------------------

describe("resolveTaskIdOrPath", () => {
  it("resolves a vault-relative path input, validating structure", async () => {
    const fs = new FakeFs().file(`${VAULT}/team/thor/inbox/20260622T153000000Z-check-disk-usage.md`, sampleTaskFile());
    const res = await resolveTaskIdOrPath(fs.deps(), VAULT, "team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
    expect(res.agentName).toBe("thor");
    expect(res.path).toBe("team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
  });

  it("resolves an id by frontmatter within a single agent", async () => {
    const fs = new FakeFs()
      .dir(`${VAULT}/team/thor/inbox`)
      .file(`${VAULT}/team/thor/inbox/20260622T153000000Z-check-disk-usage.md`, sampleTaskFile());
    const res = await resolveTaskIdOrPath(fs.deps(), VAULT, "20260622T153000000Z-check-disk-usage", "thor");
    expect(res.agentName).toBe("thor");
    expect(res.path).toBe("team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
  });

  it("resolves an id across all agents when no agent is given", async () => {
    const fs = new FakeFs()
      .dir(`${VAULT}/team/thor/inbox`)
      .dir(`${VAULT}/team/piren/inbox`)
      .file(`${VAULT}/team/thor/inbox/20260622T153000000Z-check-disk-usage.md`, sampleTaskFile());
    const res = await resolveTaskIdOrPath(fs.deps(), VAULT, "20260622T153000000Z-check-disk-usage");
    expect(res.agentName).toBe("thor");
  });

  it("finds a claimed file when resolving by id", async () => {
    const fs = new FakeFs()
      .dir(`${VAULT}/team/thor/inbox`)
      .file(`${VAULT}/team/thor/inbox/20260622T153000000Z-check-disk-usage.claimed.heimdall.md`, sampleTaskFile());
    const res = await resolveTaskIdOrPath(fs.deps(), VAULT, "20260622T153000000Z-check-disk-usage", "thor");
    expect(res.path).toBe("team/thor/inbox/20260622T153000000Z-check-disk-usage.claimed.heimdall.md");
  });

  it("errors when the id is not found", async () => {
    const fs = new FakeFs().dir(`${VAULT}/team/thor/inbox`);
    await expect(resolveTaskIdOrPath(fs.deps(), VAULT, "no-such-id", "thor")).rejects.toThrow(/not found/i);
  });

  it("errors when an id is ambiguous across agents without --agent", async () => {
    const fs = new FakeFs()
      .dir(`${VAULT}/team/thor/inbox`)
      .dir(`${VAULT}/team/piren/inbox`)
      .file(`${VAULT}/team/thor/inbox/20260622T153000000Z-check-disk-usage.md`, sampleTaskFile())
      .file(`${VAULT}/team/piren/inbox/20260622T153000000Z-check-disk-usage.md`, sampleTaskFile({ to: "piren" }));
    await expect(resolveTaskIdOrPath(fs.deps(), VAULT, "20260622T153000000Z-check-disk-usage")).rejects.toThrow(/ambiguous|--agent/i);
  });

  it("rejects a path input that escapes the vault", async () => {
    const fs = new FakeFs();
    await expect(resolveTaskIdOrPath(fs.deps(), VAULT, "../../../etc/passwd")).rejects.toThrow(/vault|outside/i);
  });

  it("rejects an invalid explicit --agent name before scanning", async () => {
    const fs = new FakeFs();
    await expect(resolveTaskIdOrPath(fs.deps(), VAULT, "some-id", "../etc")).rejects.toThrow(/agent name/i);
  });
});

// ---------------------------------------------------------------------------
// readVaultFile (body/result containment)
// ---------------------------------------------------------------------------

describe("readVaultFile", () => {
  it("reads a vault-relative file", async () => {
    const fs = new FakeFs().file(`${VAULT}/tasks/body.md`, "Do the thing.");
    const content = await readVaultFile(fs.deps(), VAULT, "tasks/body.md");
    expect(content).toBe("Do the thing.");
  });

  it("reads an absolute path inside the vault", async () => {
    const fs = new FakeFs().file(`${VAULT}/tasks/body.md`, "Do the thing.");
    const content = await readVaultFile(fs.deps(), VAULT, join(VAULT, "tasks/body.md"));
    expect(content).toBe("Do the thing.");
  });

  it("rejects traversal outside the vault", async () => {
    const fs = new FakeFs().file("/etc/passwd", "secret");
    await expect(readVaultFile(fs.deps(), VAULT, "../../../etc/passwd")).rejects.toThrow(/vault|outside/i);
  });

  it("rejects an absolute path outside the vault", async () => {
    const fs = new FakeFs().file("/etc/passwd", "secret");
    await expect(readVaultFile(fs.deps(), VAULT, "/etc/passwd")).rejects.toThrow(/vault|outside/i);
  });
});

// ---------------------------------------------------------------------------
// readTaskDetail
// ---------------------------------------------------------------------------

describe("readTaskDetail", () => {
  it("parses frontmatter and body from a task file", async () => {
    const fs = new FakeFs().file(`${VAULT}/team/thor/inbox/20260622T153000000Z-check-disk-usage.md`, sampleTaskFile({ priority: "high", body: "Special body." }));
    const detail = await readTaskDetail(fs.deps(), VAULT, "team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
    expect(detail.id).toBe("20260622T153000000Z-check-disk-usage");
    expect(detail.title).toBe("Check disk usage");
    expect(detail.from).toBe("piren");
    expect(detail.to).toBe("thor");
    expect(detail.status).toBe("pending");
    expect(detail.priority).toBe("high");
    expect(detail.requiresApproval).toBe(false);
    expect(detail.body).toContain("Special body.");
    expect(detail.body).toContain("# Check disk usage");
  });

  it("throws on a path outside the vault", async () => {
    const fs = new FakeFs();
    await expect(readTaskDetail(fs.deps(), VAULT, "../../etc/passwd")).rejects.toThrow(/vault|outside/i);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatTaskList", () => {
  it("formats a non-empty list with status, from, title and path", () => {
    const rows: TaskListRow[] = [
      {
        id: "20260622T153000000Z-check-disk-usage",
        path: "team/thor/inbox/20260622T153000000Z-check-disk-usage.md",
        title: "Check disk usage",
        from: "piren",
        to: "thor",
        status: "pending",
        priority: "normal",
        created: "2026-06-22T15:30:00.000Z",
        updated: "2026-06-22T15:30:00.000Z",
      },
    ];
    const out = formatTaskList(rows);
    expect(out).toContain("pending");
    expect(out).toContain("piren");
    expect(out).toContain("Check disk usage");
    expect(out).toContain("team/thor/inbox/20260622T153000000Z-check-disk-usage.md");
  });

  it("formats an empty list with a clear message", () => {
    expect(formatTaskList([])).toMatch(/no tasks/i);
  });
});

describe("formatTaskDetail", () => {
  it("renders key frontmatter fields and the body", () => {
    const out = formatTaskDetail({
      id: "20260622T153000000Z-check-disk-usage",
      path: "team/thor/inbox/20260622T153000000Z-check-disk-usage.md",
      title: "Check disk usage",
      from: "piren",
      to: "thor",
      status: "pending",
      priority: "high",
      created: "2026-06-22T15:30:00.000Z",
      updated: "2026-06-22T15:30:00.000Z",
      requiresApproval: false,
      body: "# Check disk usage\n\nPlease check disk usage.",
    });
    expect(out).toContain("Check disk usage");
    expect(out).toContain("piren");
    expect(out).toContain("thor");
    expect(out).toContain("pending");
    expect(out).toContain("high");
    expect(out).toContain("20260622T153000000Z-check-disk-usage.md");
    expect(out).toContain("Please check disk usage.");
  });
});

// ---------------------------------------------------------------------------
// Priority validation
// ---------------------------------------------------------------------------

describe("CLI priority validation", () => {
  it("accepts the documented priorities and rejects others", () => {
    expect(isValidCliPriority("normal")).toBe(true);
    expect(isValidCliPriority("high")).toBe(true);
    expect(isValidCliPriority("urgent")).toBe(true);
    expect(isValidCliPriority("low")).toBe(false);
    expect(isValidCliPriority("critical")).toBe(false);
    expect(isValidCliPriority("")).toBe(false);
  });

  it("exposes exactly the documented priority set", () => {
    expect([...CLI_PRIORITIES]).toEqual(["normal", "high", "urgent"]);
  });
});
