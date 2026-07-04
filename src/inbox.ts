import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface CreateInboxTaskOptions {
  vaultRoot: string;
  from: string;
  to: string;
  title: string;
  body: string;
  type?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  requiresApproval?: boolean;
  now?: () => Date;
}

export interface InboxTaskResult {
  taskId: string;
  path: string;
  absolutePath: string;
  from: string;
  to: string;
  status: TaskStatus;
  bytes: number;
  created: string;
}

export interface UpdateInboxTaskStatusOptions {
  vaultRoot: string;
  taskPath: string;
  status: TaskStatus;
  result?: string;
  now?: () => Date;
}

export interface UpdateInboxTaskStatusResult {
  path: string;
  absolutePath: string;
  status: TaskStatus;
  bytes: number;
  updated: string;
}

export interface ListInboxTasksOptions {
  vaultRoot: string;
  agentName: string;
}

export interface InboxTaskSummary {
  id: string;
  path: string;
  title: string;
  from: string;
  to: string;
  status: TaskStatus;
  created: string;
  updated: string;
}

export interface ListInboxTasksResult {
  agentName: string;
  path: string;
  absolutePath: string;
  tasks: InboxTaskSummary[];
}

export interface ClaimInboxTaskOptions {
  vaultRoot: string;
  agentName: string;
  taskPath: string;
  deviceId: string;
  staleAfterMs?: number;
  now?: () => Date;
}

export interface ClaimInboxTaskResult {
  agentName: string;
  deviceId: string;
  originalPath: string;
  path: string;
  absolutePath: string;
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertValidAgentName(agentName: string): void {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
  }
}

function assertInside(baseDir: string, target: string): void {
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path resolves outside vault: ${target}`);
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteFile(target: string, content: string): Promise<number> {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const bytes = Buffer.byteLength(content);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, target);
  return bytes;
}

function renderTask(options: {
  id: string;
  from: string;
  to: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  requiresApproval: boolean;
  timestamp: string;
}): string {
  return [
    "---",
    `type: ${options.type}`,
    `id: ${options.id}`,
    `from: ${options.from}`,
    `to: ${options.to}`,
    `priority: ${options.priority}`,
    "status: pending",
    `created: ${options.timestamp}`,
    `updated: ${options.timestamp}`,
    `requires_approval: ${options.requiresApproval}`,
    "---",
    "",
    `# ${options.title}`,
    "",
    options.body,
    "",
    "## Result",
    "",
    "Pending.",
    "",
  ].join("\n");
}

function assertValidTaskStatus(status: string): asserts status is TaskStatus {
  if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) {
    throw new Error("Invalid task status. Use pending, in_progress, completed, or cancelled.");
  }
}

function replaceFrontmatterField(content: string, field: string, value: string): string {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error("Task file is missing YAML frontmatter.");
  }
  const frontmatter = frontmatterMatch[1] ?? "";
  const fieldPattern = new RegExp(`^${field}:.*$`, "m");
  if (!fieldPattern.test(frontmatter)) {
    throw new Error(`Task file is missing required frontmatter field: ${field}`);
  }
  return content.replace(fieldPattern, `${field}: ${value}`);
}

function replaceResultSection(content: string, result: string): string {
  if (!content.includes("\n## Result\n")) {
    return `${content.replace(/\s*$/, "\n\n")}## Result\n\n${result}\n`;
  }
  return content.replace(/\n## Result\n[\s\S]*$/, `\n## Result\n\n${result}\n`);
}

function parseTaskFrontmatter(content: string, path: string): Record<string, string> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error(`Task file is missing YAML frontmatter: ${path}`);
  }
  const fields: Record<string, string> = {};
  for (const line of (frontmatterMatch[1] ?? "").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) fields[match[1] ?? ""] = match[2] ?? "";
  }
  return fields;
}

function firstMarkdownHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || "Untitled task";
}

function requireTaskField(fields: Record<string, string>, field: string, path: string): string {
  const value = fields[field];
  if (!value) throw new Error(`Task file is missing required frontmatter field '${field}': ${path}`);
  return value;
}

export async function createInboxTask(options: CreateInboxTaskOptions): Promise<InboxTaskResult> {
  assertValidAgentName(options.from);
  assertValidAgentName(options.to);
  const root = resolve(options.vaultRoot);
  const created = (options.now ?? (() => new Date()))().toISOString();
  const taskId = `${compactTimestamp(new Date(created))}-${slug(options.title)}`;
  const path = join("team", options.to, "inbox", `${taskId}.md`);
  const absolutePath = resolve(root, path);
  assertInside(root, absolutePath);

  const agentDir = join(root, "team", options.to);
  if (!(await pathExists(agentDir))) {
    throw new Error(`Target agent not found in vault: ${options.to}`);
  }

  const content = renderTask({
    id: taskId,
    from: options.from,
    to: options.to,
    title: options.title,
    body: options.body,
    type: options.type ?? "Task",
    priority: options.priority ?? "normal",
    requiresApproval: options.requiresApproval ?? false,
    timestamp: created,
  });
  const bytes = await atomicWriteFile(absolutePath, content);

  return {
    taskId,
    path: relative(root, absolutePath),
    absolutePath,
    from: options.from,
    to: options.to,
    status: "pending",
    bytes,
    created,
  };
}

export async function listInboxTasks(options: ListInboxTasksOptions): Promise<ListInboxTasksResult> {
  assertValidAgentName(options.agentName);
  const root = resolve(options.vaultRoot);
  const inboxPath = join("team", options.agentName, "inbox");
  const absolutePath = resolve(root, inboxPath);
  assertInside(root, absolutePath);

  const dirEntries = await readdir(absolutePath, { withFileTypes: true });
  const tasks: InboxTaskSummary[] = [];
  for (const entry of dirEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.includes(".claimed.")) continue;
    const taskPath = join(inboxPath, entry.name);
    const taskAbsolutePath = join(absolutePath, entry.name);
    const content = await readFile(taskAbsolutePath, "utf8");
    const fields = parseTaskFrontmatter(content, taskPath);
    const status = requireTaskField(fields, "status", taskPath);
    assertValidTaskStatus(status);
    tasks.push({
      id: requireTaskField(fields, "id", taskPath),
      path: taskPath,
      title: firstMarkdownHeading(content),
      from: requireTaskField(fields, "from", taskPath),
      to: requireTaskField(fields, "to", taskPath),
      status,
      created: requireTaskField(fields, "created", taskPath),
      updated: requireTaskField(fields, "updated", taskPath),
    });
  }
  tasks.sort((left, right) => left.created.localeCompare(right.created) || left.path.localeCompare(right.path));

  return {
    agentName: options.agentName,
    path: inboxPath,
    absolutePath,
    tasks,
  };
}

function assertInboxTaskPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  assertInside(root, absolutePath);
  const parts = rel.split(/[\\/]+/);
  if (parts.length < 4 || parts[0] !== "team" || parts[2] !== "inbox" || !parts[3]?.endsWith(".md")) {
    throw new Error("Task path must point to a Markdown task file under team/<agent>/inbox/.");
  }
  assertValidAgentName(parts[1] ?? "");
  return rel;
}

function inboxTaskPathParts(root: string, absolutePath: string): { rel: string; agentName: string; fileName: string } {
  const rel = assertInboxTaskPath(root, absolutePath);
  const parts = rel.split(/[\\/]+/);
  return { rel, agentName: parts[1] ?? "", fileName: parts.slice(3).join("/") };
}

function claimedDeviceId(fileName: string): string | undefined {
  const match = fileName.match(/\.claimed\.([a-z][a-z0-9-]*)\.md$/);
  return match?.[1];
}

async function deviceLastSeen(root: string, agentName: string, deviceId: string): Promise<string> {
  const devicePath = resolve(root, "team", agentName, "devices", `${deviceId}.json`);
  assertInside(root, devicePath);
  try {
    const parsed = JSON.parse(await readFile(devicePath, "utf8"));
    if (typeof parsed.last_seen === "string") return parsed.last_seen;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read claiming device heartbeat for '${deviceId}': ${message}`);
  }
  throw new Error(`Claiming device heartbeat is missing last_seen: ${deviceId}`);
}

async function assertClaimIsStale(options: { root: string; agentName: string; deviceId: string; staleAfterMs?: number; now?: () => Date }): Promise<void> {
  if (options.staleAfterMs === undefined) {
    throw new Error("Task is already claimed.");
  }
  const lastSeen = await deviceLastSeen(options.root, options.agentName, options.deviceId);
  const lastSeenMs = Date.parse(lastSeen);
  if (Number.isNaN(lastSeenMs)) {
    throw new Error(`Claiming device heartbeat has invalid last_seen: ${lastSeen}`);
  }
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  if (nowMs - lastSeenMs <= options.staleAfterMs) {
    throw new Error(`Task is already claimed by active device '${options.deviceId}'.`);
  }
}

export async function claimInboxTask(options: ClaimInboxTaskOptions): Promise<ClaimInboxTaskResult> {
  assertValidAgentName(options.agentName);
  assertValidAgentName(options.deviceId);
  const root = resolve(options.vaultRoot);
  const sourceAbsolutePath = resolve(root, options.taskPath);
  const { rel: originalPath, agentName, fileName } = inboxTaskPathParts(root, sourceAbsolutePath);
  if (agentName !== options.agentName) {
    throw new Error(`Task path belongs to agent '${agentName}', not selected agent '${options.agentName}'.`);
  }
  const previousDeviceId = claimedDeviceId(fileName);
  if (previousDeviceId !== undefined) {
    const staleOptions = {
      root,
      agentName: options.agentName,
      deviceId: previousDeviceId,
    } as {
      root: string;
      agentName: string;
      deviceId: string;
      staleAfterMs?: number;
      now?: () => Date;
    };
    if (options.staleAfterMs !== undefined) staleOptions.staleAfterMs = options.staleAfterMs;
    if (options.now !== undefined) staleOptions.now = options.now;
    await assertClaimIsStale(staleOptions);
  }

  const unclaimedFileName = fileName.replace(/\.claimed\.[a-z][a-z0-9-]*\.md$/, ".md");
  const claimedFileName = unclaimedFileName.replace(/\.md$/, `.claimed.${options.deviceId}.md`);
  const claimedPath = join("team", options.agentName, "inbox", claimedFileName);
  const claimedAbsolutePath = resolve(root, claimedPath);
  assertInside(root, claimedAbsolutePath);
  if (await pathExists(claimedAbsolutePath)) {
    throw new Error(`Claim target already exists: ${claimedPath}`);
  }

  await rename(sourceAbsolutePath, claimedAbsolutePath);

  return {
    agentName: options.agentName,
    deviceId: options.deviceId,
    originalPath,
    path: claimedPath,
    absolutePath: claimedAbsolutePath,
  };
}

export async function updateInboxTaskStatus(options: UpdateInboxTaskStatusOptions): Promise<UpdateInboxTaskStatusResult> {
  assertValidTaskStatus(options.status);
  const root = resolve(options.vaultRoot);
  const absolutePath = resolve(root, options.taskPath);
  const path = assertInboxTaskPath(root, absolutePath);

  const updated = (options.now ?? (() => new Date()))().toISOString();
  let content = await readFile(absolutePath, "utf8");
  content = replaceFrontmatterField(content, "status", options.status);
  content = replaceFrontmatterField(content, "updated", updated);
  if (options.result !== undefined) {
    content = replaceResultSection(content, options.result);
  }
  const bytes = await atomicWriteFile(absolutePath, content);

  return {
    path,
    absolutePath,
    status: options.status,
    bytes,
    updated,
  };
}
