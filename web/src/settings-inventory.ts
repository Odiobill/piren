/**
 * W3 (0.2.0 amendment §5/§5.1; ADR-0046): the read-only Settings workflow
 * inventory — a compile-time const model of the explicit 0.2.0 Settings
 * configuration families, grouped by the amendment's Tier A/B/C structure.
 *
 * This is a descriptive model only: it carries NO config values, NO status,
 * NO secrets, and NO live reads. The W3 shell renders it verbatim so the
 * steward can see exactly which typed workflows are planned; actual read/
 * mutation workflows arrive only in the separately gated W4–W6 slices.
 */

export type SettingsTier = "tier-a" | "tier-b" | "tier-c";

export interface SettingsFamily {
  /** Stable inventory id (kebab-case). */
  id: string;
  tier: SettingsTier;
  /** Human label. */
  label: string;
  /** Accurate bounded description of the family and its authority. */
  description: string;
  /** Bounded non-action availability statement for the W3 shell. */
  availability: string;
}

const W4_W6 = "Not available in this shell — the typed workflow arrives in a separately gated slice (W4–W6).";
const READ_ONLY_LATER = "Read-only inspection planned in a separately gated slice; nothing is read or displayed yet.";
const ACTIONS_LATER = "Not available in this shell — each explicit action arrives in a separately gated slice with its own confirmation.";

/** The explicit 0.2.0 Settings inventory (amendment §5.1), compile-time only. */
export const SETTINGS_INVENTORY: readonly SettingsFamily[] = [
  // ------------------------------------------------------------------
  // Tier A — forthcoming typed, validated edit workflows.
  // ------------------------------------------------------------------
  {
    id: "telegram",
    tier: "tier-a",
    label: "Telegram transport",
    description:
      "Bot token (write-only, never displayed), allowed chat IDs, default agent, and feedback preferences in this machine's local config. Saving never contacts the platform and never starts a service.",
    availability: W4_W6,
  },
  {
    id: "discord",
    tier: "tier-a",
    label: "Discord transport",
    description:
      "Bot token (write-only, never displayed), application/install metadata, and the server, channel, thread, and DM user allowlists plus default agent and feedback in local config. Thread and DM access stays fail-closed.",
    availability: W4_W6,
  },
  {
    id: "scheduler",
    tier: "tier-a",
    label: "Scheduler automation",
    description:
      "The local scheduler master gate and closed automation classes (inbox tasks, agent cron, script cron), poll/stale intervals, and device id. Fresh installs resolve everything off; enabling never installs or starts a service.",
    availability: W4_W6,
  },
  {
    id: "agent-model-preference",
    tier: "tier-a",
    label: "Agent model preference",
    description:
      "Each agent's preferred model id and thinking level for future launches (vault-owned agent config), validated against Pi's model id forms. Provider credentials stay in Pi's own config and are never shown here.",
    availability: W4_W6,
  },
  {
    id: "agent-model-fallback",
    tier: "tier-a",
    label: "Agent model fallback declaration",
    description:
      "An already-delivered bounded opt-in: with an enabled declaration, the same agent continues on its declared fallback models within the same live session after a fully settled, zero-side-effect provider error — ordered, at-most-once, and visible. This workflow only edits the declaration; enabling an auto-switch declaration will require an explicit extra confirmation.",
    availability: W4_W6,
  },
  {
    id: "agent-context-injection",
    tier: "tier-a",
    label: "Agent context injection",
    description:
      "How often the Piren context (identity, directives, skills catalog) is injected into an agent's sessions: every turn or once per session start.",
    availability: W4_W6,
  },
  {
    id: "agent-self-improvement",
    tier: "tier-a",
    label: "Agent self-improvement signals",
    description:
      "Opt-in, off-by-default inspectable self-improvement toggles per agent: correction auto-nudge and the bounded review loop. No hidden memory is ever written.",
    availability: W4_W6,
  },
  // ------------------------------------------------------------------
  // Tier B — read-only authority/inspection families.
  // ------------------------------------------------------------------
  {
    id: "installation-identity",
    tier: "tier-b",
    label: "Installation identity",
    description:
      "This machine's vault root and installation id. Display is read-only; changing where an installation points stays a file/CLI decision.",
    availability: READ_ONLY_LATER,
  },
  {
    id: "runnable-agent-policy",
    tier: "tier-b",
    label: "Runnable-agent policy",
    description:
      "The local allowed/excluded agent lists that decide which vault agents this machine may run. Inspection is read-only here; policy changes stay in local config or the CLI (self-lockout protection).",
    availability: READ_ONLY_LATER,
  },
  {
    id: "packages",
    tier: "tier-b",
    label: "Declared Pi packages",
    description:
      "The Pi extension packages this installation declares. Read-only display; installation and declaration changes stay machine-local.",
    availability: READ_ONLY_LATER,
  },
  {
    id: "alert-mirror",
    tier: "tier-b",
    label: "Steward alert mirror",
    description:
      "The opt-in best-effort alert mirror destinations and severity floor. Read-only display of the configured/not-configured state.",
    availability: READ_ONLY_LATER,
  },
  {
    id: "gateway-bind-token",
    tier: "tier-b",
    label: "Gateway bind and token status",
    description:
      "Whether the gateway is bound to loopback and whether an auth token is configured — never the token value itself.",
    availability: READ_ONLY_LATER,
  },
  {
    id: "service-status",
    tier: "tier-b",
    label: "Service status entries",
    description:
      "The declared installed/running status of the gateway, transport, and scheduler services as recorded in local config. Read-only display.",
    availability: READ_ONLY_LATER,
  },
  {
    id: "pi-auth-readiness",
    tier: "tier-b",
    label: "Pi auth readiness",
    description:
      "Whether Pi's own provider authentication appears ready (presence only, doctor-derived). Provider credentials themselves stay in Pi's config and are never shown.",
    availability: READ_ONLY_LATER,
  },
  // ------------------------------------------------------------------
  // Tier C — separately confirmed explicit operational service actions.
  // ------------------------------------------------------------------
  {
    id: "service-lifecycle",
    tier: "tier-c",
    label: "Service lifecycle actions",
    description:
      "Explicit operational actions for the gateway, telegram, discord, and scheduler services. Each action (install, start, stop, restart, remove) will be its own separately confirmed explicit step — saving configuration never installs, starts, stops, or restarts anything.",
    availability: ACTIONS_LATER,
  },
];

/** Families of one tier, in declaration order. */
export function familiesForTier(tier: SettingsTier): SettingsFamily[] {
  return SETTINGS_INVENTORY.filter((family) => family.tier === tier);
}
