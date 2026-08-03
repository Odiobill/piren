import { parseAuthInfo, type AuthInfoResponse } from "./auth";

/**
 * Typed fetch client for the existing gateway /api/* surface (ADR-0041
 * R3b-1). R3b-1 consumes only the public auth-info probe; room/chat/vault
 * endpoints arrive in later separately-authorized bullets and reuse this
 * module with buildAuthHeaders().
 */
export async function fetchAuthInfo(signal?: AbortSignal): Promise<AuthInfoResponse> {
  const res = await fetch("/api/auth/info", { signal });
  if (!res.ok) throw new Error(`auth info HTTP ${res.status}`);
  return parseAuthInfo(await res.json());
}
