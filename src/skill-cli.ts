/**
 * Skill CLI foundation core (Slice D).
 *
 * Pure core with injected filesystem deps for skill discovery, creation,
 * movement, promotion, demotion, conflict detection, and validation.
 * Reuses parsing helpers from src/skills.ts where possible (frontmatter
 * parsing), but never changes the loader's precedence or behavior.
 */

import { join, dirname, basename, resolve, relative, isAbsolute } from "node:path";
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

/**
 * Validate a skill name for use in file paths and YAML frontmatter.
 * Rejects: empty, ".", "..", path separators, and YAML-unsafe characters
 * (colons, tabs, newlines, and other control characters).
 *
 * The name must match: start with alphanumeric, then alphanumeric,
 * space, underscore, or dash only. This is strict enough to prevent
 * path traversal and YAML breakage while allowing readable names.
 */
export function isValidSkillName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // Reject characters that break YAML inline values or are unsafe in paths:
  // colons, tabs, newlines, and other control characters.
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) return false;
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

/**
 * Assert that an absolute path stays within the vault root. Normalizes both
 * paths and checks that the target is a descendant of (or equal to) the root.
 * Throws on any escape attempt (traversal, absolute path outside root).
 */
export function assertPathWithinVault(vaultRoot: string, absolutePath: string): void {
  const normalizedVault = resolve(vaultRoot);
  const normalizedPath = resolve(absolutePath);
  const rel = relative(normalizedVault, normalizedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path escapes vault root. Resolved: ${normalizedPath}, vault: ${normalizedVault}`,
    );
  }
}

/**
 * Verify that a parsed scope target exists in the vault:
 * - shared: always valid.
 * - group: requires agent-groups/<group>/config.yml.
 * - agent: requires team/<agent>/SOUL.md.
 */
export async function assertScopeExists(
  deps: SkillCliDeps,
  vaultRoot: string,
  scope: ParsedScope,
): Promise<void> {
  if (scope.kind === "shared") return;
  if (scope.kind === "group") {
    const configPath = join(vaultRoot, "agent-groups", scope.group ?? "", "config.yml");
    try {
      await deps.access(configPath);
    } catch {
      throw new Error(
        `Group '${scope.group ?? ""}' not found. Create it first with: piren group create ${scope.group ?? ""}`,
      );
    }
    return;
  }
  // agent scope
  const soulPath = join(vaultRoot, "team", scope.agent ?? "", "SOUL.md");
  try {
    await deps.access(soulPath);
  } catch {
    throw new Error(
      `Agent '${scope.agent ?? ""}' not found. Create it first with: piren agent add ${scope.agent ?? ""}`,
    );
  }
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

  // Determine effective: agent > groups (later group wins) > shared.
  // Must match the same precedence as resolveEffectiveSkills(): iterate
  // groups in resolution order, later groups override earlier ones.
  const agentMatch = matches.find((s) => s.source === "agent" && s.scope === agent);
  const groupMatches = matches.filter(
    (s) => s.source === "group" && groups.includes(s.scope),
  );
  const sharedMatch = matches.find((s) => s.source === "shared");

  let effective: ScannedSkill | undefined;
  if (agentMatch) {
    effective = agentMatch;
  } else {
    // Iterate groups in the order they were resolved (dir read order).
    // Later groups override earlier groups for same-name skills — same as
    // resolveEffectiveSkills(). Find the last group that has a match.
    let effectiveGroup: ScannedSkill | undefined;
    for (const groupName of groups) {
      const match = groupMatches.find((s) => s.scope === groupName);
      if (match) effectiveGroup = match;
    }
    if (effectiveGroup) {
      effective = effectiveGroup;
    } else if (sharedMatch) {
      effective = sharedMatch;
    }
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
  // Validate name safety and vault containment before any I/O.
  if (!isValidSkillName(name)) {
    throw new Error(`Invalid skill name: '${name}'. Names must start with a letter or number and contain only letters, numbers, spaces, underscores, and dashes.`);
  }

  // Ensure the target scope exists.
  await assertScopeExists(deps, vaultRoot, scope);

  const { absolutePath, vaultRelativePath } = resolveSkillPath(vaultRoot, name, scope);
  assertPathWithinVault(vaultRoot, absolutePath);

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
  // Validate name safety and vault containment before any I/O.
  if (!isValidSkillName(name)) {
    throw new Error(`Invalid skill name: '${name}'. Names must start with a letter or number and contain only letters, numbers, spaces, underscores, and dashes.`);
  }

  // Ensure the target scope exists.
  await assertScopeExists(deps, vaultRoot, to);

  const fromResolved = resolveSkillPath(vaultRoot, name, from);
  const toResolved = resolveSkillPath(vaultRoot, name, to);

  assertPathWithinVault(vaultRoot, fromResolved.absolutePath);
  assertPathWithinVault(vaultRoot, toResolved.absolutePath);

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
// Staged local skill import (Slice E1)
// ---------------------------------------------------------------------------
//
// Staged imports land in an INACTIVE, vault-visible review area. The active
// skill loader (src/skills.ts) and this module's own scanner/validator only
// ever read `skills/`, `agent-groups/<group>/skills/`, and
// `team/<agent>/skills/`. The staged directory below is never scanned by any
// active-loading path, so staged documents are guaranteed not to be injected
// into agent context, executed, or discovered until a later explicit
// promotion slice moves them into an active scope.

/**
 * Deterministic staged-import directory, relative to the vault root. It lives
 * under the established `skill-candidates/` convention (already inactive) in an
 * `imports/` sub-area that is dedicated to imported-but-unpromoted skills.
 */
export const STAGED_SKILL_DIR_REL = "skill-candidates/imports";

/** Filename slug pattern for staged imports (lowercase, no spaces). */
export const STAGED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** A staged (inactive, imported) skill document read back from the vault. */
export interface StagedSkill {
  name: string;
  description: string;
  /** Local source path recorded at import time. */
  source: string;
  /** ISO timestamp recorded at import time. */
  importedAt: string;
  /** SHA-256 hex of the original source content recorded at import time. */
  checksum: string;
  /** Whether the document carries the `staged: true` marker. */
  staged: boolean;
  /** Full Markdown body after the frontmatter. */
  body: string;
  /** Vault-relative path to the staged document. */
  path: string;
}

export interface ImportStagedSkillOptions {
  /** SHA-256 hex digest of the original source content. Injected for tests. */
  checksum: (content: string) => string;
  /** Optional explicit staged name (validated strictly; not slugified). */
  name?: string;
  /** Clock for the recorded `imported_at`; defaults to real time in the CLI. */
  now?: () => Date;
  /** Allow re-importing over an existing staged skill of the same name. */
  force?: boolean;
}

export interface ImportStagedSkillResult {
  name: string;
  /** Vault-relative path of the written staged document. */
  path: string;
  /** Local source path that was imported. */
  source: string;
  /** SHA-256 hex of the original source content. */
  checksum: string;
  /** ISO timestamp recorded as `imported_at`. */
  importedAt: string;
  /** True if a staged skill of the same name was overwritten. */
  overwritten: boolean;
}

/**
 * Derive a lowercase filename slug from arbitrary input (typically a source
 * filename stem). Returns the empty string when the input cannot be slugified
 * into a valid staged name, so callers can require an explicit `--name`.
 */
export function slugifyStagedSkillName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return STAGED_SKILL_NAME_PATTERN.test(slug) ? slug : "";
}

/** Validate a staged skill name: lowercase slug, no traversal, no separators. */
export function isValidStagedSkillName(name: string): boolean {
  if (name.includes("..")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return STAGED_SKILL_NAME_PATTERN.test(name);
}

/** Resolve the deterministic inactive path for a staged skill of `name`. */
export function resolveStagedSkillPath(
  vaultRoot: string,
  name: string,
): { absolutePath: string; vaultRelativePath: string } {
  const absolutePath = join(vaultRoot, STAGED_SKILL_DIR_REL, `${name}.md`);
  return {
    absolutePath,
    vaultRelativePath: `${STAGED_SKILL_DIR_REL}/${name}.md`,
  };
}

function sourceFileStem(sourcePath: string): string {
  return basename(sourcePath).replace(/\.md$/i, "");
}

/**
 * Parse frontmatter into the raw record plus body, tolerant of missing or
 * malformed YAML (returns `{ record: null, body }`). Used to read provenance
 * fields back from staged documents.
 */
function parseFrontmatterRecord(
  content: string,
): { record: Record<string, unknown> | null; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { record: null, body: content };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { record: null, body: content };
  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (isRecord(parsed)) return { record: parsed, body };
  } catch {
    // Malformed YAML: keep body, no record.
  }
  return { record: null, body };
}

function recordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function recordBool(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === true;
}

function renderStagedSkillDocument(args: {
  name: string;
  description: string;
  source: string;
  importedAt: string;
  checksum: string;
  body: string;
}): string {
  const frontmatter = [
    "---",
    "type: Skill",
    `name: ${args.name}`,
    `description: ${JSON.stringify(args.description)}`,
    `source: ${JSON.stringify(args.source)}`,
    `imported_at: ${args.importedAt}`,
    `checksum: ${args.checksum}`,
    "staged: true",
    "---",
    "",
  ];
  return [...frontmatter, args.body].join("\n");
}

/**
 * Import a local skill Markdown file into the inactive staged review area.
 *
 * The source content is read by the caller (CLI adapter) and passed in, so the
 * core never touches the local filesystem outside the vault. The core:
 *   - requires a `.md` source,
 *   - resolves the staged name from an explicit validated `--name` or a slug
 *     derived from the source filename stem,
 *   - normalizes frontmatter to OKF `type: Skill` while preserving the body,
 *   - records source path, import time, and content checksum as provenance,
 *   - refuses to overwrite an existing staged skill unless `force` is set.
 *
 * The destination is always under `skill-candidates/imports/`, which no active
 * skill-loading path scans.
 */
export async function importStagedSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  sourcePath: string,
  sourceContent: string,
  opts: ImportStagedSkillOptions,
): Promise<ImportStagedSkillResult> {
  if (!/\.md$/i.test(basename(sourcePath))) {
    throw new Error(`Source file must be a Markdown (.md) file: ${sourcePath}`);
  }

  let name: string;
  if (opts.name !== undefined && opts.name !== "") {
    name = opts.name;
    if (!isValidStagedSkillName(name)) {
      throw new Error(
        `Invalid staged skill name: '${name}'. Use lowercase letters, numbers, dashes, and underscores; must start with a letter or number.`,
      );
    }
  } else {
    const slug = slugifyStagedSkillName(sourceFileStem(sourcePath));
    if (slug === "") {
      throw new Error(
        `Could not derive a valid staged skill name from '${sourcePath}'. Pass --name <slug> with lowercase letters, numbers, dashes, and underscores.`,
      );
    }
    name = slug;
  }

  const { absolutePath, vaultRelativePath } = resolveStagedSkillPath(vaultRoot, name);
  assertPathWithinVault(vaultRoot, absolutePath);

  const existed = await exists(deps, absolutePath);
  if (existed && !opts.force) {
    throw new Error(
      `Staged skill '${name}' already exists at ${vaultRelativePath}. Use --force to re-import.`,
    );
  }

  const checksum = opts.checksum(sourceContent);
  const now = opts.now ?? (() => new Date());
  const importedAt = now().toISOString();

  const parsed = parseFrontmatter(sourceContent);
  const description = parsed.description ?? "";

  await deps.mkdir(dirname(absolutePath), { recursive: true });
  const content = renderStagedSkillDocument({
    name,
    description,
    source: sourcePath,
    importedAt,
    checksum,
    body: parsed.body,
  });
  await deps.writeFile(absolutePath, content);

  return { name, path: vaultRelativePath, source: sourcePath, checksum, importedAt, overwritten: existed };
}

export interface PromoteStagedSkillResult {
  name: string;
  /** Vault-relative path of the staged source that was removed. */
  fromPath: string;
  /** Vault-relative path of the active destination. */
  toPath: string;
  /** Active scope the skill was promoted into. */
  toScope: ParsedScope;
  /** True if an existing active skill was overwritten (`--force`). */
  overwritten: boolean;
  /** Set when the promotion committed but a transaction artifact could not be
   * cleaned up. The promotion succeeded; the named artifact remains as
   * recovery evidence and is protected from later overwrite. */
  cleanupWarning?: string;
}

function renderPromotedSkillDocument(args: {
  name: string;
  description: string;
  source: string;
  importedAt: string;
  checksum: string;
  body: string;
}): string {
  const frontmatter = [
    "---",
    "type: Skill",
    `name: ${args.name}`,
    `description: ${JSON.stringify(args.description)}`,
    `source: ${JSON.stringify(args.source)}`,
    `imported_at: ${args.importedAt}`,
    `checksum: ${args.checksum}`,
    "---",
    "",
  ];
  return [...frontmatter, args.body].join("\n");
}

/** Best-effort removal of a transaction artifact. Returns true on success (or
 * if it did not exist), false if it existed but could not be removed. */
async function tryRemove(deps: SkillCliDeps, path: string): Promise<boolean> {
  try {
    await deps.unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Promote exactly one E1 staged skill (`skill-candidates/imports/<name>.md`)
 * into an existing active shared/group/agent scope.
 *
 * The staged name is validated before any path resolution or filesystem
 * access. The target scope is validated with the established scope-existence
 * rules. Target collisions are refused unless `force` is set. All validation
 * and collision checks happen before any write.
 *
 * The promotion is transactional and rollback-safe: any pre-existing
 * transaction artifact (`.<name>.promote.bak`/`.promote.tmp`, recovery evidence
 * from a previous interrupted promotion) is refused before any mutation and is
 * never overwritten. The original target (when present) is moved aside to a
 * backup, the promoted content is committed via a temp file plus an atomic
 * rename (the target is never torn), and only then is the staged source
 * removed. If staged removal fails, the target is rolled back to its original
 * state (backup restored, or the just-created target removed), so a failed
 * promotion retains both the staged artifact and the original target and
 * leaves no partial activation. If rollback itself cannot complete, an explicit
 * error names the surviving artifacts instead of concealing the partial state.
 * If the backup cannot be discarded after a successful promotion, the result
 * carries a `cleanupWarning` naming the leftover artifact (it is protected from
 * later overwrite by the pre-flight check) instead of silently claiming success.
 *
 * On success the promoted document keeps `type: Skill`, the original body, and
 * the imported provenance (`source`, `imported_at`, `checksum`), drops the
 * lifecycle-only `staged: true` marker, and the staged source is removed. The
 * destination is a normal active skill file, discovered by the regular loader.
 */
export async function promoteStagedSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
  scope: ParsedScope,
  opts?: { force?: boolean },
): Promise<PromoteStagedSkillResult> {
  // 1. Validate the staged name BEFORE any path resolution or FS access.
  if (!isValidStagedSkillName(name)) {
    throw new Error(
      `Invalid staged skill name: '${name}'. Use lowercase letters, numbers, dashes, and underscores; must start with a letter or number.`,
    );
  }

  // 2. Resolve + contain the staged source path.
  const staged = resolveStagedSkillPath(vaultRoot, name);
  assertPathWithinVault(vaultRoot, staged.absolutePath);

  // 3. Validate the target scope exists (throws before any write).
  await assertScopeExists(deps, vaultRoot, scope);

  // 4. Resolve + contain the target active path.
  const target = resolveSkillPath(vaultRoot, name, scope);
  assertPathWithinVault(vaultRoot, target.absolutePath);

  // 5. Read the staged source (must exist).
  let stagedContent: string;
  try {
    stagedContent = await deps.readFile(staged.absolutePath);
  } catch {
    throw new Error(`Staged skill '${name}' not found at ${staged.vaultRelativePath}.`);
  }

  // 6. Collision check BEFORE any write (failure-safe: staged retained, target undamaged).
  const targetExists = await exists(deps, target.absolutePath);
  if (targetExists && !opts?.force) {
    throw new Error(
      `Skill '${name}' already exists at ${target.vaultRelativePath}. Use --force to overwrite.`,
    );
  }

  // 7. Resolve the transaction artifact paths and refuse pre-existing recovery
  //    artifacts BEFORE any mutation. A leftover `.promote.bak`/`.promote.tmp`
  //    is recovery evidence from a previous interrupted promotion; overwriting
  //    it (e.g. a later forced promotion's backup rename) would destroy the
  //    preserved original target. Never overwrite these artifacts.
  const targetDir = dirname(target.absolutePath);
  const targetRelDir = dirname(target.vaultRelativePath);
  const tempPath = join(targetDir, `.${name}.promote.tmp`);
  const backupPath = join(targetDir, `.${name}.promote.bak`);
  const tempRelPath = `${targetRelDir}/.${name}.promote.tmp`;
  const backupRelPath = `${targetRelDir}/.${name}.promote.bak`;
  assertPathWithinVault(vaultRoot, tempPath);
  assertPathWithinVault(vaultRoot, backupPath);
  const blockingArtifacts: string[] = [];
  if (await exists(deps, tempPath)) blockingArtifacts.push(tempRelPath);
  if (await exists(deps, backupPath)) blockingArtifacts.push(backupRelPath);
  if (blockingArtifacts.length > 0) {
    throw new Error(
      `Cannot promote '${name}': a transaction artifact from a previous interrupted promotion already exists (${blockingArtifacts.join(", ")}). ` +
        `It may be recovery evidence. Inspect it and remove it manually before retrying.`,
    );
  }

  // 8. Parse staged provenance + body.
  const { record, body } = parseFrontmatterRecord(stagedContent);
  const description = (record && asString(record.description)) ?? "";
  const source = record ? recordString(record, "source") : "";
  const importedAt = record ? recordString(record, "imported_at") : "";
  const checksum = record ? recordString(record, "checksum") : "";

  // 9. Render the promoted document (drop staged marker; keep type: Skill + provenance).
  const promoted = renderPromotedSkillDocument({
    name,
    description,
    source,
    importedAt,
    checksum,
    body,
  });

  // Transactional, rollback-safe promotion (see the pre-flight artifact check
  // in step 7 for collision handling). Two original artifacts must survive any
  // failure: the staged source and (when present) the original target. We:
  //   (a) move the original target aside to a backup if it exists (--force),
  //   (b) commit the promoted content to the target via a temp file + atomic
  //       rename so the target is never torn,
  //   (c) remove the staged source; on failure roll the target back to its
  //       original state (restore the backup, or remove the just-created target).
  // If rollback itself cannot complete we throw an explicit error naming the
  // surviving artifacts, rather than concealing a partial state.
  await deps.mkdir(targetDir, { recursive: true });

  // (a) Back up the original target so it can be restored on failure.
  if (targetExists) {
    await deps.rename(target.absolutePath, backupPath);
  }

  // (b) Commit: write the promoted content to a temp file, then atomically
  //     rename it over the target. On failure, restore the original target.
  try {
    await deps.writeFile(tempPath, promoted);
    await deps.rename(tempPath, target.absolutePath);
  } catch (commitErr) {
    await tryRemove(deps, tempPath);
    if (targetExists) {
      try {
        await deps.rename(backupPath, target.absolutePath);
      } catch {
        throw new Error(
          `Promotion of '${name}' failed during commit and the original target could not be restored. ` +
            `The original skill is preserved at ${backupPath}; the staged copy remains at ${staged.vaultRelativePath}. ` +
            `Restore the original manually. Cause: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
        );
      }
    }
    throw commitErr;
  }

  // (c) Remove the staged source. On failure, roll the target back to its
  //     original state so the vault reflects the pre-promotion state.
  try {
    await deps.unlink(staged.absolutePath);
  } catch (unlinkErr) {
    let rolledBack = false;
    if (targetExists) {
      // Restore the original target (atomically overwrites the promoted copy).
      try {
        await deps.rename(backupPath, target.absolutePath);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    } else {
      // No original target: remove the just-created promoted target.
      try {
        await deps.unlink(target.absolutePath);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }
    if (rolledBack) {
      throw unlinkErr;
    }
    throw new Error(
      `Promotion of '${name}' committed to ${target.vaultRelativePath} but could not remove the staged source, and rollback failed. ` +
        `The promoted skill may be active at ${target.vaultRelativePath}` +
        (targetExists ? ` while the original is preserved at ${backupPath}` : "") +
        `; the staged copy remains at ${staged.vaultRelativePath}. Inspect and clean up manually.`,
    );
  }

  // 10. Success: discard the backup that held the original target. If it cannot
  //     be removed, surface an explicit incomplete-cleanup condition rather than
  //     silently claiming success; the leftover backup is protected from later
  //     overwrite by the pre-flight artifact check.
  let cleanupWarning: string | undefined;
  if (targetExists && !(await tryRemove(deps, backupPath))) {
    cleanupWarning =
      `Promotion succeeded, but the original-target backup could not be removed and remains at ${backupRelPath}. ` +
      `It is protected from later overwrite; remove it manually once verified.`;
  }

  const result: PromoteStagedSkillResult = {
    name,
    fromPath: staged.vaultRelativePath,
    toPath: target.vaultRelativePath,
    toScope: scope,
    overwritten: targetExists,
  };
  if (cleanupWarning !== undefined) result.cleanupWarning = cleanupWarning;
  return result;
}

/**
 * List staged skill documents deterministically (sorted by name). Returns an
 * empty list when the staged area does not exist. Tolerant of malformed
 * frontmatter: the name falls back to the filename stem.
 */
export async function listStagedSkills(
  deps: SkillCliDeps,
  vaultRoot: string,
): Promise<StagedSkill[]> {
  const dir = join(vaultRoot, STAGED_SKILL_DIR_REL);
  let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[];
  try {
    entries = await deps.readdir(dir);
  } catch {
    return [];
  }

  const results: StagedSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = await deps.readFile(filePath);
    } catch {
      continue;
    }

    const { record, body } = parseFrontmatterRecord(content);
    const name = (record && asString(record.name)) ?? deriveName(entry.name);
    results.push({
      name,
      description: (record && asString(record.description)) ?? "",
      source: record ? recordString(record, "source") : "",
      importedAt: record ? recordString(record, "imported_at") : "",
      checksum: record ? recordString(record, "checksum") : "",
      staged: record ? recordBool(record, "staged") : false,
      body,
      path: `${STAGED_SKILL_DIR_REL}/${entry.name}`,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Show a single staged skill by resolved name; null when not found. */
export async function showStagedSkill(
  deps: SkillCliDeps,
  vaultRoot: string,
  name: string,
): Promise<StagedSkill | null> {
  const all = await listStagedSkills(deps, vaultRoot);
  return all.find((s) => s.name === name) ?? null;
}

/** Format a staged skill list deterministically (sorted, provenance per entry). */
export function formatStagedSkillList(skills: StagedSkill[]): string {
  if (skills.length === 0) return "No staged skills found.";
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`${s.name}  (imported ${s.importedAt || "unknown"})`);
    lines.push(`  source:   ${s.source || "(unknown)"}`);
    lines.push(`  checksum: ${s.checksum || "(unknown)"}`);
    lines.push(`  ${s.description || "(no description)"}`);
  }
  return lines.join("\n");
}

/** Format a single staged skill with full provenance and body. */
export function formatStagedSkillShow(skill: StagedSkill): string {
  const lines: string[] = [];
  lines.push(`Name: ${skill.name}`);
  lines.push(`Path: ${skill.path}`);
  lines.push(`Source: ${skill.source || "(unknown)"}`);
  lines.push(`Imported: ${skill.importedAt || "(unknown)"}`);
  lines.push(`Checksum: ${skill.checksum || "(unknown)"}`);
  if (skill.description) lines.push(`Description: ${skill.description}`);
  lines.push(`Staged: ${skill.staged ? "true (inactive, not loaded)" : "false"}`);
  lines.push("");
  lines.push(skill.body);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Real adapter
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile as fsReadFile, writeFile, mkdir as fsMkdir, stat as fsStat, readdir as fsReaddir, rename, unlink, rmdir, access } from "node:fs/promises";

/** Real SHA-256 hex digest for staged-import provenance. */
export function realSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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
