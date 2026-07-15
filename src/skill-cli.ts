/**
 * Skill CLI foundation core (Slice D).
 *
 * Pure core with injected filesystem deps for skill discovery, creation,
 * movement, promotion, demotion, conflict detection, and validation.
 * Reuses parsing helpers from src/skills.ts where possible (frontmatter
 * parsing), but never changes the loader's precedence or behavior.
 */

import { join, dirname, basename } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected filesystem operations, structurally compatible with node:fs/promises. */
export interface SkillCliDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  readdir(path: string): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  access(path: string): Promise<void>;
}

export type SkillSource = "shared" | "group" | "agent";

export interface ScannedSkill {
  name: string;
  description: string;
  body: string;
  source: SkillSource;
  /** Scope identifier: "shared", group name, or agent name. */
  scope: string;
  /** Vault-relative path. */
  path: string;
  /** Whether this is a directory-based skill (SKILL.md inside a dir). */
  isDirectory: boolean;
}

export interface SkillListOptions {
  agent?: string;
  group?: string;
  scope?: SkillSource;
}

export interface SkillExplainResult {
  effective: ScannedSkill;
  shadowed: ScannedSkill[];
}

export interface SkillConflict {
  name: string;
  entries: { source: SkillSource; scope: string; path: string }[];
}

export interface SkillValidationIssue {
  kind: "missing-type" | "unparseable-frontmatter" | "missing-frontmatter";
  path: string;
  message: string;
}

export interface CreateSkillOptions {
  force?: boolean;
}

export interface MoveSkillOptions {
  force?: boolean;
}

/**
 * Parsed scope from `--scope shared|group:<name>|agent:<name>`.
 */
export interface ParsedScope {
  kind: SkillSource;
  group?: string;
  agent?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (mirrors src/skills.ts helper, kept self-contained for
// the CLI layer so we don't depend on loader internals.)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

interface ParsedFrontmatter {
  name: string | null;
  description: string | null;
  type: string | null;
  body: string;
  frontmatterRaw: string | null;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { name: null, description: null, type: null, body: content, frontmatterRaw: null };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { name: null, description: null, type: null, body: content, frontmatterRaw: null };
  }

  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");

  let name: string | null = null;
  let description: string | null = null;
  let type: string | null = null;
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (isRecord(parsed)) {
      name = asString(parsed.name);
      description = asString(parsed.description);
      type = asString(parsed.type);
    }
  } catch {
    // Malformed YAML: keep the body, null metadata.
  }

  return { name, description, type, body, frontmatterRaw: yamlText };
}

// ---------------------------------------------------------------------------
// Name & scope helpers
// ---------------------------------------------------------------------------

function deriveName(fileName: string): string {
  return basename(fileName).replace(/\.md$/i, "");
}

/** Validate a skill name: non-empty, no path separators, no . or .. */
export function isValidSkillName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

/** Parse a scope string like "shared", "group:devs", "agent:dipu". */
export function parseScope(raw: string): ParsedScope | null {
  if (raw === "shared") return { kind: "shared" };
  if (raw.startsWith("group:")) {
    const group = raw.slice("group:".length);
    if (!isValidSkillName(group)) return null;
    return { kind: "group", group };
  }
  if (raw.startsWith("agent:")) {
    const agent = raw.slice("agent:".length);
    if (!isValidSkillName(agent)) return null;
    return { kind: "agent", agent };
  }
  return null;
}

/** Format a parsed scope back to its string representation. */
export function formatScope(scope: ParsedScope): string {
  if (scope.kind === "shared") return "shared";
  if (scope.kind === "group") return `group:${scope.group ?? ""}`;
  return `agent:${scope.agent ?? ""}`;
}

/**
 * Resolve the vault-relative path for a skill with a given name and scope.
 * For directory-based skills (detected by existence), the path resolves to
 * `<dir>/SKILL.md`. By default we target a loose `.md` file.
 */
export function resolveSkillPath(
  vaultRoot: string,
  name: string,
  scope: ParsedScope,
): { absolutePath: string; vaultRelativePath: string } {
  let dir: string;
  let vaultRelDir: string;
  if (scope.kind === "shared") {
    dir = join(vaultRoot, "skills");
    vaultRelDir = "skills";
  } else if (scope.kind === "group") {
    dir = join(vaultRoot, "agent-groups", scope.group ?? "", "skills");
    vaultRelDir = `agent-groups/${scope.group ?? ""}/skills`;
  } else {
    dir = join(vaultRoot, "team", scope.agent ?? "", "skills");
    vaultRelDir = `team/${scope.agent ?? ""}/skills`;
  }
  return {
    absolutePath: join(dir, `${name}.md`),
    vaultRelativePath: `${vaultRelDir}/${name}.md`,
  };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Scan a single skills directory for skill files (both loose .md and
 * directory-based SKILL.md). Returns annotated entries with source and scope.
 */
async function scanSkillsDir(
  deps: SkillCliDeps,
  dir: string,
  relBase: string,
  source: SkillSource,
  scope: string,
): Promise<ScannedSkill[]> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await deps.readdir(dir);
  } catch {
    return [];
  }

  const results: ScannedSkill[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const filePath = join(dir, entry.name);
      let content: string;
      try {
        content = await deps.readFile(filePath);
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(content);
      results.push({
        name: parsed.name ?? deriveName(entry.name),
        description: parsed.description ?? "",
        body: parsed.body,
        source,
        scope,
        path: `${relBase}/${entry.name}`,
        isDirectory: false,
      });
    } else if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, "SKILL.md");
      try {
        await deps.stat(skillMd);
      } catch {
        continue;
      }
      let content: string;
      try {
        content = await deps.readFile(skillMd);
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(content);
      results.push({
        name: parsed.name ?? entry.name,
        description: parsed.description ?? "",
        body: parsed.body,
        source,
        scope,
        path: `${relBase}/${entry.name}/SKILL.md`,
        isDirectory: true,
      });
    }
  }

  return results;
}

/** Check if a vault path exists (file or directory). */
async function exists(deps: SkillCliDeps, path: string): Promise<boolean> {
  try {
    await deps.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan ALL skills in the vault: shared, all groups, and all agents.
 * Returns a flat list with full scope annotation.
 */
export async function scanAllSkills(
  deps: SkillCliDeps,
  vaultRoot: string,
): Promise<ScannedSkill[]> {
  const all: ScannedSkill[] = [];

  // Shared
  all.push(...(await scanSkillsDir(deps, join(vaultRoot, "skills"), "skills", "shared", "shared")));

  // Groups
  let groupDirs: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
  try {
    groupDirs = await deps.readdir(join(vaultRoot, "agent-groups"));
  } catch {
    // No agent-groups dir
  }
  for (const entry of groupDirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const groupName = entry.name;
    all.push(
      ...(await scanSkillsDir(
        deps,
        join(vaultRoot, "agent-groups", groupName, "skills"),
        `agent-groups/${groupName}/skills`,
        "group",
        groupName,
      )),
    );
  }

  // Agents
  let agentDirs: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
  try {
    agentDirs = await deps.readdir(join(vaultRoot, "team"));
  } catch {
    // No team dir
  }
  for (const entry of agentDirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const agentName = entry.name;
    all.push(
      ...(await scanSkillsDir(
        deps,
        join(vaultRoot, "team", agentName, "skills"),
        `team/${agentName}/skills`,
        "agent",
        agentName,
      )),
    );
  }

  return all;
}

/**
 * Resolve agent groups from the vault (reads agent-groups configs to find
 * which groups the agent belongs to). Returns an empty array if no configs
 * or agent not found.
 */
async function resolveAgentGroupsForSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  agent: string,
): Promise<string[]> {
  const groups: string[] = [];
  try {
    const entries = await deps.readdir(join(vaultRoot, "agent-groups"));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const configPath = join(vaultRoot, "agent-groups", entry.name, "config.yml");
      try {
        const content = await deps.readFile(configPath);
        const parsed = parseYaml(content) as unknown;
        if (isRecord(parsed) && Array.isArray(parsed.agents)) {
          const members = parsed.agents.filter((a): a is string => typeof a === "string");
          if (members.includes(agent)) {
            groups.push(entry.name);
          }
        }
      } catch {
        // No config or unparseable — skip
      }
    }
  } catch {
    // No agent-groups dir
  }
  return groups;
}

/**
 * Get the effective skill set for an agent, respecting precedence:
 * shared < group < agent. Returns skills sorted by name.
 */
export async function resolveEffectiveSkills(
  deps: SkillCliDeps,
  vaultRoot: string,
  agent: string,
): Promise<ScannedSkill[]> {
  const all = await scanAllSkills(deps, vaultRoot);
  const groups = await resolveAgentGroupsForSkill(deps, vaultRoot, agent);

  // Precedence map: shared < groups < agent
  // Higher precedence overwrites lower on name collision.
  const byName = new Map<string, ScannedSkill>();

  for (const skill of all) {
    if (skill.source === "shared") {
      byName.set(skill.name, skill);
    }
  }

  for (const skill of all) {
    if (skill.source === "group" && groups.includes(skill.scope)) {
      byName.set(skill.name, skill);
    }
  }

  for (const skill of all) {
    if (skill.source === "agent" && skill.scope === agent) {
      byName.set(skill.name, skill);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Filter a scanned skill list by options.
 * - `agent`: show effective skills for that agent (using precedence).
 * - `group`: show skills scoped to that specific group.
 * - `scope`: show skills only from that source type.
 */
export async function filterSkills(
  deps: SkillCliDeps,
  vaultRoot: string,
  all: ScannedSkill[],
  opts: SkillListOptions,
): Promise<ScannedSkill[]> {
  let result = all;

  if (opts.agent !== undefined) {
    result = await resolveEffectiveSkills(deps, vaultRoot, opts.agent);
  }

  if (opts.group !== undefined) {
    result = result.filter((s) => s.source === "group" && s.scope === opts.group);
  }

  if (opts.scope !== undefined) {
    result = result.filter((s) => s.source === opts.scope);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

export interface SkillShowResult {
  skill: ScannedSkill;
}

/**
 * Show the full body of one skill, resolved with agent precedence.
 * Returns null if the skill is not found.
 */
export async function showSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  agent?: string,
): Promise<SkillShowResult | null> {
  if (agent !== undefined) {
    const effective = await resolveEffectiveSkills(deps, vaultRoot, agent);
    const found = effective.find((s) => s.name === name);
    return found ? { skill: found } : null;
  }

  // No agent: search all scopes, return the first found (alphabetical
  // tiebreaker by source precedence: shared < group < agent).
  const all = await scanAllSkills(deps, vaultRoot);
  const matches = all.filter((s) => s.name === name);
  if (matches.length === 0) return null;

  // Precedence: agent > group > shared
  const precOrder: SkillSource[] = ["agent", "group", "shared"];
  for (const prec of precOrder) {
    const match = matches.find((s) => s.source === prec);
    if (match) return { skill: match };
  }

  return { skill: matches[0]! };
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

/**
 * Explain provenance: which scope provides the effective copy, and which
 * lower-precedence copies are shadowed.
 */
export async function explainSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  agent: string,
): Promise<SkillExplainResult | null> {
  const all = await scanAllSkills(deps, vaultRoot);
  const groups = await resolveAgentGroupsForSkill(deps, vaultRoot, agent);

  const matches = all.filter((s) => s.name === name);
  if (matches.length === 0) return null;

  // Determine effective: agent > group (if in group) > shared
  const agentMatch = matches.find((s) => s.source === "agent" && s.scope === agent);
  const groupMatches = matches.filter(
    (s) => s.source === "group" && groups.includes(s.scope),
  );
  const sharedMatch = matches.find((s) => s.source === "shared");

  let effective: ScannedSkill | undefined;
  if (agentMatch) {
    effective = agentMatch;
  } else if (groupMatches.length > 0) {
    // Highest-precedence group wins. The order of groups doesn't matter
    // here — pick the first one for display, or the one that would win
    // in precedence order.
    effective = groupMatches[0];
  } else if (sharedMatch) {
    effective = sharedMatch;
  }

  if (!effective) {
    // The skill exists but not in any scope visible to this agent.
    // Return first match as effective.
    effective = matches[0]!;
  }

  const shadowed = matches.filter((s) => s !== effective);
  return { effective, shadowed };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new skill file with frontmatter at the correct vault path.
 * Refuses to overwrite an existing skill without --force.
 */
export async function createSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  scope: ParsedScope,
  opts?: CreateSkillOptions,
): Promise<{ path: string }> {
  const { absolutePath, vaultRelativePath } = resolveSkillPath(vaultRoot, name, scope);

  const alreadyExists = await exists(deps, absolutePath);
  if (alreadyExists && !opts?.force) {
    throw new Error(
      `Skill '${name}' already exists at ${vaultRelativePath}. Use --force to overwrite.`,
    );
  }

  // Ensure parent directory exists
  await deps.mkdir(dirname(absolutePath), { recursive: true });

  const frontmatter = [
    "---",
    "type: Skill",
    `name: ${name}`,
    "description: ",
    "---",
    "",
    "",
  ].join("\n");

  await deps.writeFile(absolutePath, frontmatter);
  return { path: vaultRelativePath };
}

// ---------------------------------------------------------------------------
// Move (rename between scopes)
// ---------------------------------------------------------------------------

/**
 * Move a skill file from one scope to another. Preserves frontmatter and body.
 * Refuses to overwrite the target without --force.
 */
export async function moveSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  from: ParsedScope,
  to: ParsedScope,
  opts?: MoveSkillOptions,
): Promise<{ fromPath: string; toPath: string }> {
  const fromResolved = resolveSkillPath(vaultRoot, name, from);
  const toResolved = resolveSkillPath(vaultRoot, name, to);

  // Check source exists (could be loose .md or directory SKILL.md)
  let sourcePath: string | null = null;
  let isDir = false;

  if (await exists(deps, fromResolved.absolutePath)) {
    sourcePath = fromResolved.absolutePath;
    isDir = false;
  } else {
    // Check if it's a directory-based skill
    const dirPath = join(dirname(fromResolved.absolutePath), name);
    const skillMdPath = join(dirPath, "SKILL.md");
    if (await exists(deps, skillMdPath)) {
      sourcePath = skillMdPath;
      isDir = true;
    }
  }

  if (!sourcePath) {
    throw new Error(`Skill '${name}' not found in scope ${formatScope(from)}.`);
  }

  // If source is a directory-based skill, move the whole directory.
  // If source is a loose .md, move the file.

  const targetExists =
    (await exists(deps, toResolved.absolutePath)) ||
    (await exists(deps, join(dirname(toResolved.absolutePath), name, "SKILL.md")));

  if (targetExists && !opts?.force) {
    throw new Error(
      `Skill '${name}' already exists in scope ${formatScope(to)}. Use --force to overwrite.`,
    );
  }

  // Ensure target directory exists
  await deps.mkdir(dirname(toResolved.absolutePath), { recursive: true });

  if (targetExists && opts?.force) {
    // Remove existing target
    try {
      await deps.unlink(toResolved.absolutePath);
    } catch {
      // Might be directory-based
      try {
        await deps.unlink(join(dirname(toResolved.absolutePath), name, "SKILL.md"));
        await deps.rmdir(join(dirname(toResolved.absolutePath), name));
      } catch {
        // ignore
      }
    }
  }

  if (isDir) {
    // Move the whole directory
    const sourceDir = dirname(sourcePath);
    const targetDir = join(dirname(toResolved.absolutePath), name);
    await deps.mkdir(targetDir, { recursive: true });
    const targetSkillMd = join(targetDir, "SKILL.md");
    // Read content, write to new location, remove old
    const content = await deps.readFile(sourcePath);
    await deps.writeFile(targetSkillMd, content);
    await deps.unlink(sourcePath);
    try {
      await deps.rmdir(sourceDir);
    } catch {
      // Directory might have other files; best-effort cleanup.
    }
    return {
      fromPath: fromResolved.vaultRelativePath,
      toPath: `${dirname(toResolved.vaultRelativePath)}/${name}/SKILL.md`,
    };
  } else {
    await deps.rename(sourcePath, toResolved.absolutePath);
    return { fromPath: fromResolved.vaultRelativePath, toPath: toResolved.vaultRelativePath };
  }
}

// ---------------------------------------------------------------------------
// Promote / Demote
// ---------------------------------------------------------------------------

export async function promoteSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  fromAgent: string,
  to: "shared" | { kind: "group"; group: string },
  opts?: MoveSkillOptions,
): Promise<{ fromPath: string; toPath: string }> {
  const from: ParsedScope = { kind: "agent", agent: fromAgent };
  const toScope: ParsedScope =
    to === "shared" ? { kind: "shared" } : { kind: "group", group: to.group };
  return moveSkill(deps, vaultRoot, name, from, toScope, opts);
}

export async function demoteSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  from: "shared" | { kind: "group"; group: string },
  toAgent: string,
  opts?: MoveSkillOptions,
): Promise<{ fromPath: string; toPath: string }> {
  const fromScope: ParsedScope =
    from === "shared" ? { kind: "shared" } : { kind: "group", group: from.group };
  const to: ParsedScope = { kind: "agent", agent: toAgent };
  return moveSkill(deps, vaultRoot, name, fromScope, to, opts);
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * Report same-name skills that exist in multiple scopes, creating
 * shadowing. When agent is provided, only reports conflicts for scopes
 * visible to that agent.
 */
export async function listConflicts(
  deps: SkillCliDeps,
  vaultRoot: string,
  agent?: string,
): Promise<SkillConflict[]> {
  const all = await scanAllSkills(deps, vaultRoot);

  let relevant = all;
  if (agent !== undefined) {
    const groups = await resolveAgentGroupsForSkill(deps, vaultRoot, agent);
    relevant = all.filter((s) => {
      if (s.source === "shared") return true;
      if (s.source === "group" && groups.includes(s.scope)) return true;
      if (s.source === "agent" && s.scope === agent) return true;
      return false;
    });
  }

  // Group by name
  const byName = new Map<string, ScannedSkill[]>();
  for (const skill of relevant) {
    const list = byName.get(skill.name) ?? [];
    list.push(skill);
    byName.set(skill.name, list);
  }

  const conflicts: SkillConflict[] = [];
  for (const [name, skills] of byName) {
    if (skills.length <= 1) continue;
    // Check if multiple different scopes have the same name
    const uniqueScopes = new Set(skills.map((s) => `${s.source}:${s.scope}`));
    if (uniqueScopes.size <= 1) continue;

    conflicts.push({
      name,
      entries: skills.map((s) => ({
        source: s.source,
        scope: s.scope,
        path: s.path,
      })),
    });
  }

  return conflicts.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validate all skill files for OKF frontmatter conformance.
 * Reports missing/empty type fields, unparseable frontmatter, and files
 * without frontmatter.
 */
export async function validateSkills(
  deps: SkillCliDeps,
  vaultRoot: string,
): Promise<SkillValidationIssue[]> {
  const all = await scanAllSkills(deps, vaultRoot);
  const issues: SkillValidationIssue[] = [];

  for (const skill of all) {
    // Read the raw file to check frontmatter validity
    let rawContent: string;
    try {
      const absPath = join(vaultRoot, skill.path);
      rawContent = await deps.readFile(absPath);
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(rawContent);

    if (parsed.frontmatterRaw === null) {
      issues.push({
        kind: "missing-frontmatter",
        path: skill.path,
        message: `Skill '${skill.name}' at ${skill.path} is missing YAML frontmatter.`,
      });
      continue;
    }

    // Check if the YAML was parseable
    let yamlParsedOk = false;
    try {
      parseYaml(parsed.frontmatterRaw);
      yamlParsedOk = true;
    } catch {
      // Unparseable
    }

    if (!yamlParsedOk) {
      issues.push({
        kind: "unparseable-frontmatter",
        path: skill.path,
        message: `Skill '${skill.name}' at ${skill.path} has unparseable YAML frontmatter.`,
      });
      continue;
    }

    if (parsed.type === null) {
      issues.push({
        kind: "missing-type",
        path: skill.path,
        message: `Skill '${skill.name}' at ${skill.path} is missing the required 'type' field in frontmatter.`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Format a scanned skill list as a compact table. */
export function formatSkillList(skills: ScannedSkill[]): string {
  if (skills.length === 0) return "No skills found.";

  const lines: string[] = [];
  // Calculate column widths
  const nameWidth = Math.max(6, ...skills.map((s) => s.name.length));
  const sourceWidth = Math.max(6, ...skills.map((s) => {
    const scope = s.source === "shared" ? "shared" : s.scope;
    return `${s.source}:${scope}`.length;
  }));

  lines.push(
    `${"NAME".padEnd(nameWidth)}  ${"SOURCE".padEnd(sourceWidth)}  DESCRIPTION`,
  );
  lines.push(
    `${"-".repeat(nameWidth)}  ${"-".repeat(sourceWidth)}  ${"-".repeat(10)}`,
  );

  for (const skill of skills) {
    const scope = skill.source === "shared" ? "shared" : skill.scope;
    const sourceLabel = `${skill.source}:${scope}`;
    const desc = skill.description || "-";
    lines.push(
      `${skill.name.padEnd(nameWidth)}  ${sourceLabel.padEnd(sourceWidth)}  ${desc}`,
    );
  }

  return lines.join("\n");
}

/** Format a single skill's full body. */
export function formatSkillShow(result: SkillShowResult): string {
  const { skill } = result;
  const lines: string[] = [];
  lines.push(`Name: ${skill.name}`);
  lines.push(`Source: ${skill.source}:${skill.scope}`);
  lines.push(`Path: ${skill.path}`);
  if (skill.description) {
    lines.push(`Description: ${skill.description}`);
  }
  lines.push("");
  lines.push(skill.body);
  return lines.join("\n");
}

/** Format the explain result: effective + shadowed. */
export function formatSkillExplain(result: SkillExplainResult): string {
  const lines: string[] = [];
  lines.push(`Skill: ${result.effective.name}`);
  lines.push("");
  lines.push("Effective (active):");
  lines.push(`  ${result.effective.source}:${result.effective.scope} -> ${result.effective.path}`);
  lines.push(`  ${result.effective.description || "(no description)"}`);

  if (result.shadowed.length > 0) {
    lines.push("");
    lines.push("Shadowed (inactive):");
    for (const shadowed of result.shadowed) {
      lines.push(`  ${shadowed.source}:${shadowed.scope} -> ${shadowed.path}`);
    }
  } else {
    lines.push("");
    lines.push("Shadowed (inactive): none");
  }

  return lines.join("\n");
}

/** Format conflicts report. */
export function formatSkillConflicts(conflicts: SkillConflict[]): string {
  if (conflicts.length === 0) return "No skill conflicts found.";

  const lines: string[] = [];
  lines.push(`Found ${conflicts.length} skill name conflict(s):`);
  lines.push("");

  for (const conflict of conflicts) {
    lines.push(`${conflict.name}:`);
    for (const entry of conflict.entries) {
      lines.push(`  ${entry.source}:${entry.scope} -> ${entry.path}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Format validation issues. */
export function formatSkillValidation(issues: SkillValidationIssue[]): string {
  if (issues.length === 0) return "All skill files passed validation.";

  const lines: string[] = [];
  lines.push(`Found ${issues.length} skill validation issue(s):`);
  lines.push("");

  for (const issue of issues) {
    lines.push(`[${issue.kind}] ${issue.message}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Real adapter
// ---------------------------------------------------------------------------

import { readFile as fsReadFile, writeFile, mkdir as fsMkdir, stat as fsStat, readdir as fsReaddir, rename, unlink, rmdir, access } from "node:fs/promises";

export function createRealSkillCliDeps(): SkillCliDeps {
  return {
    readFile: async (path: string) => {
      const buf = await fsReadFile(path);
      return buf.toString("utf8");
    },
    writeFile,
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      await fsMkdir(path, options);
    },
    stat: async (p) => {
      const s = await fsStat(p);
      return { isDirectory: () => s.isDirectory() };
    },
    readdir: async (p) => {
      const entries = await fsReaddir(p, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.isDirectory(),
        isFile: () => e.isFile(),
      }));
    },
    rename,
    unlink,
    rmdir,
    access: async (p) => {
      await access(p);
    },
  };
}
