/**
 * Gateway auth helpers for the Piren web UI (Phase 3 tracer bullet 6).
 *
 * A shared bootstrap token gates the gateway. On localhost (the default
 * bind) auth is optional for friction-free local development. On any
 * non-localhost bind the token is required and the gateway refuses to
 * start without one.
 *
 * The token lives in `~/.config/piren/gateway-token` (installation
 * authority, outside the vault) or is passed via env (`PIREN_TOKEN`) or
 * CLI (`--token`). If auto-generated on first run, the token is printed
 * to the console once.
 *
 * Transport is plain `Authorization: Bearer ***` on API requests. This
 * module is pure-ish (host classification, constant-time matching, token
 * file read/write/generation); the HTTP enforcement lives in
 * gateway-http.ts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/**
 * Whether a bind hostname is safe enough to serve without a token. Only
 * the loopback address and the `localhost` name qualify. Any other bind
 * (0.0.0.0, a LAN IP, a hostname) requires the auth token.
 */
export function isLocalhostBind(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/**
 * Extract the bearer token from an Authorization header value. Returns the
 * raw token string, or `null` if the header is absent or not a `Bearer`
 * scheme.
 */
export function extractBearerToken(header: string | undefined | null): string | null {
  if (typeof header !== "string" || header === "") return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token === "" ? null : token;
}

/**
 * Constant-time string comparison. Compares every byte regardless of where
 * the first difference is, so timing does not leak the length of the shared
 * prefix. Returns true only when both strings are equal length and content.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk both strings to keep timing uniform-ish. The result is
    // already false because of the length mismatch.
    let acc = 1;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const ca = i < a.length ? a.charCodeAt(i) : 0;
      const cb = i < b.length ? b.charCodeAt(i) : 0;
      acc |= ca ^ cb;
    }
    return acc === 0 && a.length === b.length;
  }
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

/**
 * Whether an incoming Authorization header authorizes the request against
 * the expected shared token. Uses a constant-time comparison so that a
 * timing attack cannot progressively reconstruct the token byte-by-byte.
 *
 * Returns false for any of: missing header, wrong scheme, empty token, or
 * token mismatch. A server with no configured token (`expectedToken === ""`)
 * never authorizes via this function; localhost-optional auth is handled by
 * the caller.
 */
export function isBearerAuthorized(
  header: string | undefined | null,
  expectedToken: string,
): boolean {
  if (expectedToken === "") return false;
  const presented = extractBearerToken(header);
  if (presented === null) return false;
  return timingSafeEqualString(presented, expectedToken);
}

export interface AuthGateInput {
  /** The hostname the server will bind to. */
  hostname: string;
  /** The resolved shared token, or "" when none is configured. */
  token: string;
}

/**
 * The start-time auth gate. A non-localhost bind without a token is a
 * fail-closed configuration: the gateway would otherwise serve open on a
 * LAN with the power to drive tool execution, vault writes, and shell
 * access. This throws a clear message instead of silently serving open.
 *
 * On localhost the token is optional for friction-free local development;
 * the caller may still pass a token, in which case per-request auth is
 * enforced by the HTTP layer.
 */
export function assertAuthGate(input: AuthGateInput): void {
  if (input.token !== "") return;
  if (isLocalhostBind(input.hostname)) return;
  throw new Error(
    `Auth token is required when binding to a non-localhost address (${input.hostname}). ` +
      `Set PIREN_TOKEN, pass --token, or store a token in ${defaultTokenFilePath()}.`,
  );
}

/**
 * Default path for the persisted gateway token: `~/.config/piren/gateway-token`.
 * Installation authority lives outside the vault, never inside it.
 */
export function defaultTokenFilePath(): string {
  return join(homedir(), ".config", "piren", "gateway-token");
}

/** Default token length in bytes (decoded). Produces a 43-char base64url string. */
export const DEFAULT_TOKEN_BYTES = 32;

/**
 * Generate a cryptographically random URL-safe token. Uses crypto.randomBytes
 * encoded as base64url (no padding), which is safe to put in an Authorization
 * header and in a URL query string. The caller controls the byte count so tests
 * can request deterministic lengths.
 */
export function generateToken(byteLength = DEFAULT_TOKEN_BYTES): string {
  return randomBytes(byteLength).toString("base64url");
}

export type TokenSource = "cli" | "env" | "file" | "generated" | "none";

export interface ResolvedToken {
  /** The shared token, or "" when none is configured. */
  token: string;
  /** Where the token came from, for startup logging. */
  source: TokenSource;
}

export interface ResolveTokenOptions {
  /** Token passed via `--token`. Highest priority. */
  cliToken?: string | undefined;
  /** Token from `PIREN_TOKEN` env. */
  envToken?: string | undefined;
  /** Path to the persisted token file. */
  tokenPath: string;
  /**
   * When true and no token is found anywhere, generate one, persist it to
   * `tokenPath`, and return it. The caller prints it once. Default false.
   */
  generate?: boolean | undefined;
}

/**
 * Resolve the gateway auth token by priority: CLI `--token` > `PIREN_TOKEN`
 * env > token file. If none is found and `generate` is true, a new token is
 * created, persisted to `tokenPath` (with the parent directory created if
 * needed), and returned with source "generated". Otherwise returns an empty
 * token with source "none".
 *
 * Whitespace and trailing newlines are trimmed from file/env values so a
 * token written by an editor that appends a newline still matches.
 */
export async function resolveGatewayToken(options: ResolveTokenOptions): Promise<ResolvedToken> {
  const cli = options.cliToken?.trim() ?? "";
  if (cli !== "") return { token: cli, source: "cli" };

  const env = options.envToken?.trim() ?? "";
  if (env !== "") return { token: env, source: "env" };

  const fromFile = await readTokenFile(options.tokenPath);
  if (fromFile !== "") return { token: fromFile, source: "file" };

  if (options.generate) {
    const generated = generateToken();
    await writeTokenFile(options.tokenPath, generated);
    return { token: generated, source: "generated" };
  }

  return { token: "", source: "none" };
}

async function readTokenFile(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

async function writeTokenFile(path: string, token: string): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(path, token + "\n", { encoding: "utf8", mode: 0o600 });
}
