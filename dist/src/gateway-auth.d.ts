/**
 * Whether a bind hostname is safe enough to serve without a token. Only
 * the loopback address and the `localhost` name qualify. Any other bind
 * (0.0.0.0, a LAN IP, a hostname) requires the auth token.
 */
export declare function isLocalhostBind(hostname: string): boolean;
/**
 * Extract the bearer token from an Authorization header value. Returns the
 * raw token string, or `null` if the header is absent or not a `Bearer`
 * scheme.
 */
export declare function extractBearerToken(header: string | undefined | null): string | null;
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
export declare function isBearerAuthorized(header: string | undefined | null, expectedToken: string): boolean;
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
export declare function assertAuthGate(input: AuthGateInput): void;
/**
 * Default path for the persisted gateway token: `~/.config/piren/gateway-token`.
 * Installation authority lives outside the vault, never inside it.
 */
export declare function defaultTokenFilePath(): string;
/** Default token length in bytes (decoded). Produces a 43-char base64url string. */
export declare const DEFAULT_TOKEN_BYTES = 32;
/**
 * Generate a cryptographically random URL-safe token. Uses crypto.randomBytes
 * encoded as base64url (no padding), which is safe to put in an Authorization
 * header and in a URL query string. The caller controls the byte count so tests
 * can request deterministic lengths.
 */
export declare function generateToken(byteLength?: number): string;
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
export declare function resolveGatewayToken(options: ResolveTokenOptions): Promise<ResolvedToken>;
