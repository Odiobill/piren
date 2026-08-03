/**
 * In-memory-only gateway auth helpers for the workbench shell (ADR-0041
 * R3b-1). Pure and framework-free so the contract is directly unit-testable.
 * The bearer token never touches browser storage (R3a-1 §3): it lives in
 * React state for the lifetime of the page and is dropped on reload.
 */

/** Shell authentication phases. */
export type AuthPhase = "loading" | "token-needed" | "ready";

/**
 * Honest shell status (ADR-0041 R3b-1 review): the R3b-1 shell never claims
 * a token is authenticated or validated. A token is only "ready" (held in
 * memory); validation happens only when a later authorized slice makes its
 * first protected request and the gateway accepts it.
 */
export type ShellAuthStatus =
  | { status: "ready-local" } // gateway reachable, no token required (localhost)
  | { status: "token-needed" } // gateway requires a token, none entered yet
  | { status: "token-ready"; token: string }; // token entered, in memory, NOT validated

/** Resolve the honest shell status from the auth probe and current token. */
export function resolveShellAuth(authRequired: boolean, token: string): ShellAuthStatus {
  if (!authRequired) return { status: "ready-local" };
  const trimmed = token.trim();
  return trimmed === "" ? { status: "token-needed" } : { status: "token-ready", token: trimmed };
}

/** Validated shape of the public GET /api/auth/info response. */
export interface AuthInfoResponse {
  authRequired: boolean;
}

/** Fail-closed validation of the public /api/auth/info response body. */
export function parseAuthInfo(json: unknown): AuthInfoResponse {
  if (typeof json === "object" && json !== null && "authRequired" in json) {
    const value = (json as { authRequired?: unknown }).authRequired;
    if (typeof value === "boolean") return { authRequired: value };
  }
  throw new Error("unexpected /api/auth/info response");
}

/**
 * Build the Authorization header for a Bearer token, or no header when the
 * token is empty. The token is trimmed; an all-whitespace value yields no
 * header so a stale/blank input never sends a malformed credential.
 */
export function buildAuthHeaders(token: string): Record<string, string> {
  const trimmed = token.trim();
  return trimmed === "" ? {} : { Authorization: `Bearer ${trimmed}` };
}
