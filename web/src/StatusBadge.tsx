/**
 * Auth-phase status badge shared by the pre-auth shell and the workbench
 * app shell (ADR-0041 R3b-1/R3b-2.5). Honest wording: the shell never
 * claims a token is authenticated before a protected request succeeds.
 */
export type ShellPhase =
  | "loading"
  | "error"
  | "token-needed"
  | "ready-local"
  | "token-ready"
  | "token-accepted";

export function StatusBadge({ phase }: { phase: ShellPhase }) {
  // A loaded localhost Workbench confirms reachability by being usable; only
  // actionable auth/connection states deserve persistent header chrome.
  if (phase === "ready-local") return null;
  const text =
    phase === "loading"
      ? "Connecting…"
      : phase === "error"
        ? "Connection error"
        : phase === "token-needed"
          ? "Token required"
          : phase === "token-ready"
            ? "Token ready"
            : "Token accepted";
  const tone =
    phase === "token-accepted"
      ? "ok"
      : phase === "error"
        ? "error"
        : phase === "token-needed" || phase === "token-ready"
          ? "warn"
          : "idle";
  return (
    <span className={`status-badge status-${tone}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}
