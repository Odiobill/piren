import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Where a skill was discovered: shared (vault/skills/) or agent (team/<agent>/skills/). */
export type SkillSource = "shared" | "agent";

/**
 * A single loaded skill. Skills are procedures (Markdown context the agent can
 * follow), not executable tools. They are injected into the agent's context
 * prompt so the agent knows they exist and can apply them when relevant.
 */
export interface VaultSkill {
  /** Skill name, from frontmatter `name` or derived from the filename. */
  name: string;
  /** One-line description from frontmatter `description`. May be empty. */
  description: string;
  /** Full Markdown body (everything after the frontmatter). */
  body: string;
  /** Where the skill was loaded from. */
  source: SkillSource;
  /** Vault-relative path to the skill file. */
  path: string;
}

export interface LoadVaultSkillsResult {
  skills: VaultSkill[];
}

interface RawSkill {
  name: string;
  description: string;
  body: string;
  path: string;
  fileName: string;
}

interface ParsedFrontmatter {
  name: string | null;
  description: string | null;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Parse YAML frontmatter (between leading `---` fences) and return the name,
 * description, and the body after the fences. Files without frontmatter keep
 * the entire content as the body with null metadata.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { name: null, description: null, body: content };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Opening fence with no closing fence: treat the whole file as body.
    return { name: null, description: null, body: content };
  }

  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");

  let name: string | null = null;
  let description: string | null = null;
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (isRecord(parsed)) {
      name = asString(parsed.name);
      description = asString(parsed.description);
    }
  } catch {
    // Malformed YAML frontmatter: fall back to null metadata, keep the body.
  }

  return { name, description, body };
}

function deriveName(fileName: string): string {
  return basename(fileName).replace(/\.md$/i, "");
}

/**
 * Scan a single skills directory for skill files. Collects both loose `.md`
 * files and `SKILL.md` inside subdirectories. Returns raw entries; the caller
 * resolves shared/agent precedence and assembles the final list.
 */
async function scanSkillsDir(dir: string, relBase: string): Promise<RawSkill[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
      return [];
    }
    throw err;
  }

  const results: RawSkill[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const filePath = join(dir, entry.name);
      const content = await readFile(filePath, "utf8");
      const parsed = parseFrontmatter(content);
      results.push({
        name: parsed.name ?? deriveName(entry.name),
        description: parsed.description ?? "",
        body: parsed.body,
        path: `${relBase}/${entry.name}`,
        fileName: entry.name,
      });
    } else if (entry.isDirectory()) {
      // Directory-based skill: read SKILL.md inside it.
      const skillMd = join(dir, entry.name, "SKILL.md");
      try {
        await stat(skillMd);
      } catch {
        continue;
      }
      const content = await readFile(skillMd, "utf8");
      const parsed = parseFrontmatter(content);
      results.push({
        name: parsed.name ?? entry.name,
        description: parsed.description ?? "",
        body: parsed.body,
        path: `${relBase}/${entry.name}/SKILL.md`,
        fileName: "SKILL.md",
      });
    }
  }

  return results;
}

/**
 * Load skills from the vault for a given agent.
 *
 * Shared skills come from `vault/skills/` (available to all agents).
 * Agent-specific skills come from `team/<agent>/skills/` (available only to
 * that agent). Agent-specific skills override shared skills with the same
 * name.
 *
 * Skills are Markdown files with optional YAML frontmatter (`name`,
 * `description`) and a body. A directory containing `SKILL.md` is also a
 * skill. The loader is tolerant: a missing skills directory returns an empty
 * list, and malformed frontmatter does not crash loading (the skill is
 * included with a derived name and empty description).
 *
 * See ADR-0014 for the full design.
 */
export async function loadVaultSkills(vaultRoot: string, agentName: string): Promise<LoadVaultSkillsResult> {
  const sharedDir = join(vaultRoot, "skills");
  const agentDir = join(vaultRoot, "team", agentName, "skills");

  const [shared, agent] = await Promise.all([
    scanSkillsDir(sharedDir, "skills"),
    scanSkillsDir(agentDir, `team/${agentName}/skills`),
  ]);

  // Build a name-keyed map. Shared skills first, then agent-specific skills
  // override any with the same name.
  const byName = new Map<string, VaultSkill>();
  for (const raw of shared) {
    byName.set(raw.name, {
      name: raw.name,
      description: raw.description,
      body: raw.body,
      source: "shared",
      path: raw.path,
    });
  }
  for (const raw of agent) {
    byName.set(raw.name, {
      name: raw.name,
      description: raw.description,
      body: raw.body,
      source: "agent",
      path: raw.path,
    });
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills };
}

/**
 * Format the loaded skills as a context-prompt section. Lists each skill's
 * name, description, source, and full body. Returns an empty string when no
 * skills are loaded.
 */
export function formatSkillsForContext(skills: VaultSkill[]): string {
  if (skills.length === 0) return "";
  const lines = ["## Available Skills", "Follow these procedures when the steward asks or when a task matches:"];
  for (const skill of skills) {
    lines.push("");
    lines.push(`### ${skill.name} (${skill.source})`);
    if (skill.description) {
      lines.push(skill.description);
    }
    lines.push("");
    lines.push(skill.body);
  }
  return lines.join("\n");
}
