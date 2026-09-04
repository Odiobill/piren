import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  closeStewardAlert,
  isDirectActiveStewardAlertPath,
  parseStewardAlert,
  projectStewardAlerts,
  type StewardAlert,
  type StewardAlertProjection,
} from "./steward-alerts.js";

const MAX_ACTIVE_ALERTS = 100;

export class StewardAlertStoreError extends Error {
  constructor(
    message: string,
    readonly kind: "bad-request" | "not-found" | "conflict",
  ) {
    super(message);
    this.name = "StewardAlertStoreError";
  }
}

function alertAbsolutePath(vaultRoot: string, path: string): string {
  if (!isDirectActiveStewardAlertPath(path)) {
    throw new StewardAlertStoreError("alert path must name one direct active alert", "bad-request");
  }
  return resolve(vaultRoot, path);
}

function mapReadError(error: unknown): StewardAlertStoreError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) return new StewardAlertStoreError("alert not found", "not-found");
  return new StewardAlertStoreError(`cannot read alert: ${message}`, "bad-request");
}

async function atomicReplace(target: string, content: string): Promise<void> {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
}

/** Read and strictly validate exactly one direct active alert. */
export async function readStewardAlert(vaultRoot: string, path: string): Promise<{ alert: StewardAlert; content: string }> {
  const absolutePath = alertAbsolutePath(vaultRoot, path);
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw mapReadError(error);
  }
  try {
    return { alert: parseStewardAlert({ path, content }), content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StewardAlertStoreError(`invalid alert: ${message}`, "bad-request");
  }
}

/** Read the bounded direct active-alert directory and produce its projection. */
export async function listStewardAlerts(vaultRoot: string): Promise<StewardAlertProjection> {
  const directory = resolve(vaultRoot, "steward-inbox", "alerts");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw mapReadError(error);
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (names.length > MAX_ACTIVE_ALERTS) {
    throw new StewardAlertStoreError(`too many active alerts (maximum ${MAX_ACTIVE_ALERTS})`, "bad-request");
  }

  const alerts: StewardAlert[] = [];
  for (const name of names) {
    const path = `steward-inbox/alerts/${name}`;
    const result = await readStewardAlert(vaultRoot, path);
    alerts.push(result.alert);
  }
  return projectStewardAlerts(alerts);
}

/**
 * Close one exact open alert. The caller supplies the only accepted expected
 * state; it cannot use this adapter to reopen or edit alert content.
 */
export async function closeStoredStewardAlert(options: {
  vaultRoot: string;
  path: string;
  expectedStatus: "open";
  now?: () => Date;
}): Promise<StewardAlert> {
  const current = await readStewardAlert(options.vaultRoot, options.path);
  if (current.alert.status !== options.expectedStatus) {
    throw new StewardAlertStoreError("alert is already closed", "conflict");
  }
  const closedAt = (options.now ?? (() => new Date()))().toISOString();
  let next: ReturnType<typeof closeStewardAlert>;
  try {
    next = closeStewardAlert({ path: options.path, content: current.content, closedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StewardAlertStoreError(`cannot close alert: ${message}`, "conflict");
  }
  try {
    await atomicReplace(alertAbsolutePath(options.vaultRoot, options.path), next.content);
    return next.alert;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StewardAlertStoreError(`cannot close alert: ${message}`, "bad-request");
  }
}
