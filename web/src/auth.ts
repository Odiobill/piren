/**
 * In-memory-only gateway auth helpers for the workbench shell (ADR-0041
 * R3b-1). Pure and framework-free so the contract is directly unit-testable.
 * The bearer token never touches browser storage (R3a-1 §3): it lives in
 * React state for the lifetime of the page and is dropped on reload.
 */

/** Shell authentication phases. */
export type AuthPhase = "loading" | "token-needed" | "ready";

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
