import { readFile, access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createVaultTools } from "./vault-tools.js";

export interface ProjectStatusOptions {
  vaultRoot: string;
  project: string;
}

export interface ProjectStatusResult {
  project: string;
  path: string;
  available: boolean;
  title: string;
  status: string;
  updated: string;
}

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

function assertValidProjectName(project: string): void {
  if (!project || project.trim() === "") {
    throw new Error("Project name is required");
  }
  if (project.includes("/") || project.includes("\\") || project.includes("..")) {
    throw new Error(`Invalid project name: ${project}`);
  }
  if (!PROJECT_NAME_PATTERN.test(project)) {
    throw new Error(`Invalid project name: ${project}`);
  }
}

function assertInsideVault(vaultRoot: string, target: string): void {
  const rel = relative(vaultRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path resolves outside vault: ${target}`);
  }
}

function parseFrontmatter(content: string): { fields: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const rawFields = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = parseYaml(rawFields) as unknown;
  const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return { fields, body };
}

function projectIndexPath(project: string): string {
  return `Projects/${project}/index.md`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function projectStatus(options: ProjectStatusOptions): Promise<ProjectStatusResult> {
  assertValidProjectName(options.project);
  const root = resolve(options.vaultRoot);
  const indexPath = projectIndexPath(options.project);
  const absolutePath = resolve(root, indexPath);
  assertInsideVault(root, absolutePath);

  const exists = await pathExists(absolutePath);
  if (!exists) {
    return {
      project: options.project,
      path: indexPath,
      available: false,
      title: "",
      status: "",
      updated: "",
    };
  }

  const content = await readFile(absolutePath, "utf8");
  const { fields } = parseFrontmatter(content);
  return {
    project: options.project,
    path: indexPath,
    available: true,
    title: typeof fields.title === "string" ? fields.title : "",
    status: typeof fields.status === "string" ? fields.status : "",
    updated: typeof fields.updated === "string" ? fields.updated : "",
  };
}

export interface ProjectAppendLogOptions {
  vaultRoot: string;
  project: string;
  entry: string;
  agentName?: string;
  now?: () => Date;
}

export interface ProjectAppendLogResult {
  path: string;
  absolutePath: string;
  bytes: number;
  bytesAppended: number;
  timestamp: string;
  atomic: true;
}

export interface DecisionRecordOptions {
  vaultRoot: string;
  project: string;
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string;
  now?: () => Date;
}

export interface DecisionRecordResult {
  path: string;
  absolutePath: string;
  bytes: number;
  atomic: true;
  created: string;
}

export async function projectAppendLog(options: ProjectAppendLogOptions): Promise<ProjectAppendLogResult> {
  assertValidProjectName(options.project);
  const entry = options.entry.trim();
  if (!entry) {
    throw new Error("Project log entry is required");
  }

  const now = options.now ?? (() => new Date());
  const tools = createVaultTools({ vaultRoot: options.vaultRoot, now });
  const logPath = `Projects/${options.project}/log.md`;
  const normalizedEntry = entry.endsWith("\n") ? entry.slice(0, -1) : entry;
  const entryBody = options.agentName ? `agent: ${options.agentName}\n${normalizedEntry}` : normalizedEntry;
  const result = await tools.vaultAppendLog(logPath, entryBody);
  if (!("bytesAppended" in result)) {
    throw new Error(`Project log append was queued instead of written authoritatively: ${(result as { reason: string }).reason}`);
  }
  return {
    path: result.path,
    absolutePath: result.absolutePath,
    bytes: result.bytes,
    bytesAppended: result.bytesAppended,
    timestamp: result.timestamp,
    atomic: true,
  };
}

const ADR_ID_PATTERN = /^\d{4}$/;

function assertValidAdrId(id: string): void {
  if (!ADR_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ADR id: ${id}. Use a 4-digit number, for example '0015'.`);
  }
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "decision";
}

function renderAdr(options: {
  id: string;
  title: string;
  created: string;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string;
}): string {
  const heading = `ADR-${options.id} - ${options.title}`;
  const lines = [
    "---",
    `title: "${heading}"`,
    `created: ${options.created.slice(0, 10)}`,
    "updated: " + options.created.slice(0, 10),
    "tags: [piren, adr, decision]",
    "status: accepted",
    "---",
    "",
    `# ${heading}`,
    "",
    "## Status",
    "",
    "Accepted.",
    "",
    "## Context",
    "",
    options.context,
    "",
    "## Decision",
    "",
    options.decision,
    "",
  ];
  if (options.consequences !== undefined) {
    lines.push("## Consequences", "", options.consequences, "");
  }
  if (options.alternatives !== undefined) {
    lines.push("## Alternatives", "", options.alternatives, "");
  }
  return lines.join("\n");
}

export async function decisionRecord(options: DecisionRecordOptions): Promise<DecisionRecordResult> {
  assertValidProjectName(options.project);
  assertValidAdrId(options.id);
  if (!options.title.trim()) {
    throw new Error("ADR title is required");
  }
  if (!options.context.trim()) {
    throw new Error("ADR context is required");
  }
  if (!options.decision.trim()) {
    throw new Error("ADR decision is required");
  }

  const now = options.now ?? (() => new Date());
  const created = now().toISOString();
  const slug = slugifyTitle(options.title);
  const path = `Projects/${options.project}/decisions/ADR-${options.id}-${slug}.md`;
  const renderOptions: {
    id: string;
    title: string;
    created: string;
    context: string;
    decision: string;
    consequences?: string;
    alternatives?: string;
  } = {
    id: options.id,
    title: options.title,
    created,
    context: options.context,
    decision: options.decision,
  };
  if (options.consequences !== undefined) renderOptions.consequences = options.consequences;
  if (options.alternatives !== undefined) renderOptions.alternatives = options.alternatives;
  const content = renderAdr(renderOptions);

  const tools = createVaultTools({ vaultRoot: options.vaultRoot, now });
  const result = await tools.vaultWrite(path, content);
  if (!("path" in result)) {
    throw new Error(`ADR was queued instead of written authoritatively: ${result.reason}`);
  }
  return {
    path: result.path,
    absolutePath: result.absolutePath,
    bytes: result.bytes,
    atomic: true,
    created,
  };
}

export interface ProjectUpdateHandoffOptions {
  vaultRoot: string;
  project: string;
  content: string;
  now?: () => Date;
}

export interface ArtifactWriteResult {
  path: string;
  absolutePath: string;
  bytes: number;
  atomic: true;
  created: string;
}

export interface ProjectUpdateHandoffResult {
  path: string;
  absolutePath: string;
  bytes: number;
  atomic: true;
}

export interface RunbookWriteOptions {
  vaultRoot: string;
  project: string;
  title: string;
  content: string;
  now?: () => Date;
}

export interface SkillCandidateWriteOptions {
  vaultRoot: string;
  name: string;
  description: string;
  body: string;
  scope?: string;
  now?: () => Date;
}

const SKILL_CANDIDATE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function assertValidSkillCandidateName(name: string): void {
  if (!SKILL_CANDIDATE_NAME_PATTERN.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid skill candidate name: ${name}`);
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function writeAuthoritative(options: { vaultRoot: string; path: string; content: string; now?: () => Date; label: string }) {
  const toolOptions: { vaultRoot: string; now?: () => Date } = { vaultRoot: options.vaultRoot };
  if (options.now !== undefined) toolOptions.now = options.now;
  const tools = createVaultTools(toolOptions);
  const result = await tools.vaultWrite(options.path, options.content);
  if (!("path" in result)) {
    throw new Error(`${options.label} was queued instead of written authoritatively: ${result.reason}`);
  }
  return result;
}

export async function projectUpdateHandoff(options: ProjectUpdateHandoffOptions): Promise<ProjectUpdateHandoffResult> {
  assertValidProjectName(options.project);
  if (!options.content.trim()) {
    throw new Error("Project handoff content is required");
  }
  const path = `Projects/${options.project}/handoff-prompt.md`;
  const writeOptions: { vaultRoot: string; path: string; content: string; now?: () => Date; label: string } = {
    vaultRoot: options.vaultRoot,
    path,
    content: options.content,
    label: "Project handoff",
  };
  if (options.now !== undefined) writeOptions.now = options.now;
  const result = await writeAuthoritative(writeOptions);
  return {
    path: result.path,
    absolutePath: result.absolutePath,
    bytes: result.bytes,
    atomic: true,
  };
}

export async function runbookWrite(options: RunbookWriteOptions): Promise<ArtifactWriteResult> {
  assertValidProjectName(options.project);
  const title = assertNonEmpty(options.title, "Runbook title");
  const body = assertNonEmpty(options.content, "Runbook content");
  const now = options.now ?? (() => new Date());
  const created = now().toISOString();
  const slug = slugifyTitle(title);
  const path = `Projects/${options.project}/runbooks/${slug}.md`;
  const content = [
    "---",
    `title: ${yamlString(title)}`,
    "type: runbook",
    `project: ${yamlString(options.project)}`,
    `created: ${created.slice(0, 10)}`,
    `updated: ${created.slice(0, 10)}`,
    "tags: [piren, runbook]",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
  const result = await writeAuthoritative({ vaultRoot: options.vaultRoot, path, content, now, label: "Runbook" });
  return {
    path: result.path,
    absolutePath: result.absolutePath,
    bytes: result.bytes,
    atomic: true,
    created,
  };
}

export async function skillCandidateWrite(options: SkillCandidateWriteOptions): Promise<ArtifactWriteResult> {
  assertValidSkillCandidateName(options.name);
  const description = assertNonEmpty(options.description, "Skill candidate description");
  const body = assertNonEmpty(options.body, "Skill candidate body");
  const scope = options.scope?.trim();
  if (scope !== undefined && scope !== "") {
    assertValidProjectName(scope);
  }
  const now = options.now ?? (() => new Date());
  const created = now().toISOString();
  const path = scope ? `Projects/${scope}/skill-candidates/${options.name}.md` : `skill-candidates/${options.name}.md`;
  const frontmatter = [
    "---",
    `name: ${options.name}`,
    `description: ${yamlString(description)}`,
    "status: candidate",
    "type: skill-candidate",
    `created: ${created.slice(0, 10)}`,
    `updated: ${created.slice(0, 10)}`,
  ];
  if (scope) frontmatter.push(`scope: ${scope}`);
  frontmatter.push("---");
  const content = [
    ...frontmatter,
    "",
    `# ${options.name}`,
    "",
    description,
    "",
    "## Candidate Body",
    "",
    body,
    "",
  ].join("\n");
  const result = await writeAuthoritative({ vaultRoot: options.vaultRoot, path, content, now, label: "Skill candidate" });
  return {
    path: result.path,
    absolutePath: result.absolutePath,
    bytes: result.bytes,
    atomic: true,
    created,
  };
}
