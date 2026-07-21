import { mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type AlertSeverity = "low" | "normal" | "high" | "urgent";
export type AlertStatus = "open";

export interface CreateStewardAlertOptions {
  vaultRoot: string;
  from: string;
  title: string;
  body: string;
  severity?: AlertSeverity;
  notify?: boolean;
  now?: () => Date;
}

export interface StewardAlertResult {
  alertId: string;
  path: string;
  absolutePath: string;
  from: string;
  severity: AlertSeverity;
  status: AlertStatus;
  notify: boolean;
  bytes: number;
  created: string;
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const ALERT_SEVERITIES = new Set(["low", "normal", "high", "urgent"]);

function assertValidAgentName(agentName: string): void {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
  }
}

function assertValidSeverity(severity: string): asserts severity is AlertSeverity {
  if (!ALERT_SEVERITIES.has(severity)) {
    throw new Error("Invalid alert severity. Use low, normal, high, or urgent.");
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
    .replace(/^-+|-+$/g, "") || "alert";
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

function renderAlert(options: {
  id: string;
  from: string;
  title: string;
  body: string;
  severity: AlertSeverity;
  notify: boolean;
  timestamp: string;
}): string {
  return [
    "---",
    "type: Alert",
    `id: ${options.id}`,
    `from: ${options.from}`,
    `severity: ${options.severity}`,
    "status: open",
    `created: ${options.timestamp}`,
    `notify: ${options.notify}`,
    "---",
    "",
    `# ${options.title}`,
    "",
    options.body,
    "",
  ].join("\n");
}

export async function createStewardAlert(options: CreateStewardAlertOptions): Promise<StewardAlertResult> {
  assertValidAgentName(options.from);
  const severity = options.severity ?? "normal";
  assertValidSeverity(severity);
  const root = resolve(options.vaultRoot);
  const created = (options.now ?? (() => new Date()))().toISOString();
  const alertId = `${compactTimestamp(new Date(created))}-${slug(options.title)}`;
  const path = `steward-inbox/alerts/${alertId}.md`;
  const absolutePath = resolve(root, path);
  assertInside(root, absolutePath);

  const notify = options.notify ?? true;
  const content = renderAlert({
    id: alertId,
    from: options.from,
    title: options.title,
    body: options.body,
    severity,
    notify,
    timestamp: created,
  });
  const bytes = await atomicWriteFile(absolutePath, content);

  return {
    alertId,
    path: relative(root, absolutePath),
    absolutePath,
    from: options.from,
    severity,
    status: "open",
    notify,
    bytes,
    created,
  };
}
