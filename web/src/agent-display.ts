/**
 * 0.2.5 S6 — centralized presentation-only agent display names.
 *
 * One pure text formatter for every first-party Workbench surface that shows
 * an agent identifier to the steward. Canonical lowercase agent identifiers
 * are preserved everywhere authority or identity matters (React keys,
 * input/select values, request bodies, mention insertion, routing,
 * comparisons, config writes, durable data); this module only formats the
 * rendered form and never mutates its input.
 */
export function agentDisplayName(name: string): string {
  return name
    .split("-")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
