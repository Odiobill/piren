import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface RegisterDeviceOptions {
  vaultRoot: string;
  agentName: string;
  deviceId: string;
  hostname: string;
  priority?: number;
  status?: "active" | "idle" | "offline";
  now?: () => Date;
}

export interface RegisterDeviceResult {
  agentName: string;
  deviceId: string;
  hostname: string;
  path: string;
  absolutePath: string;
  priority: number;
  status: "active" | "idle" | "offline";
  startedAt: string;
  lastSeen: string;
  bytes: number;
}

const SAFE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertValidSafeName(value: string, label: string): void {
  if (!SAFE_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}. Use lowercase kebab-case, for example 'heimdall' or 'piren-local'.`);
  }
}

function assertInside(baseDir: string, target: string): void {
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path resolves outside vault: ${target}`);
  }
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

async function existingStartedAt(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed.started_at === "string" ? parsed.started_at : undefined;
  } catch {
    return undefined;
  }
}

async function existingPriority(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed.priority === "number" && Number.isFinite(parsed.priority) ? parsed.priority : undefined;
  } catch {
    return undefined;
  }
}

export async function registerDevice(options: RegisterDeviceOptions): Promise<RegisterDeviceResult> {
  assertValidSafeName(options.agentName, "agent name");
  assertValidSafeName(options.deviceId, "device id");
  const root = resolve(options.vaultRoot);
  const agentDir = resolve(root, "team", options.agentName);
  assertInside(root, agentDir);
  if (!(await pathExists(agentDir))) {
    throw new Error(`Agent not found in vault: ${options.agentName}`);
  }

  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const path = join("team", options.agentName, "devices", `${options.deviceId}.json`);
  const absolutePath = resolve(root, path);
  assertInside(root, absolutePath);
  const startedAt = await existingStartedAt(absolutePath) ?? timestamp;
  const priority = options.priority ?? await existingPriority(absolutePath) ?? 10;
  const status = options.status ?? "active";
  const record = {
    device_id: options.deviceId,
    hostname: options.hostname,
    priority,
    status,
    started_at: startedAt,
    last_seen: timestamp,
  };
  const bytes = await atomicWriteFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`);

  return {
    agentName: options.agentName,
    deviceId: options.deviceId,
    hostname: options.hostname,
    path,
    absolutePath,
    priority,
    status,
    startedAt,
    lastSeen: timestamp,
    bytes,
  };
}
