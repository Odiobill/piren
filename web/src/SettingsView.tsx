import { familiesForTier, type SettingsFamily, type SettingsTier } from "./settings-inventory.js";
import { TelegramSettingsForm } from "./TelegramSettingsForm.js";
import { DiscordSettingsForm } from "./DiscordSettingsForm.js";
import { SchedulerSettingsForm } from "./SchedulerSettingsForm.js";
import { AgentPreferencesForm } from "./AgentPreferencesForm.js";

/**
 * W3 + W5 (0.2.0 amendment §5; ADR-0046): the full-page Settings module.
 * W3 rendered the static read-only Tier A/B/C inventory; W5 replaces the
 * Telegram and Discord "not available" presentations with typed, validated
 * write-only-token workflows. Every OTHER family stays static/read-only; no
 * model/thinking/live-session/runnable-policy/gateway-token/provider-credential
 * UI is added. No generic editor, no storage, no service/platform action.
 */

const TIER_PRESENTATION: Record<SettingsTier, { heading: string; blurb: string }> = {
  "tier-a": {
    heading: "Typed configuration workflows",
    blurb:
      "Telegram, Discord, scheduler automation, and agent preferences are editable here through typed, validated workflows. The remaining families stay gated until later slices.",
  },
  "tier-b": {
    heading: "Read-only inspection",
    blurb:
      "These authority and status families will be displayed read-only in a later gated slice. Nothing is read or probed yet.",
  },
  "tier-c": {
    heading: "Operational service actions",
    blurb:
      "Service actions will arrive as separately confirmed explicit steps in a later gated slice. Saving configuration never installs, starts, stops, or restarts anything.",
  },
};

const TIER_IDS: Record<SettingsTier, string> = {
  "tier-a": "settings-tier-a-heading",
  "tier-b": "settings-tier-b-heading",
  "tier-c": "settings-tier-c-heading",
};

function FamilyItem({ family }: { family: SettingsFamily }) {
  return (
    <li className="settings-family">
      <strong>{family.label}</strong>
      <p className="muted">{family.description}</p>
      <p className="muted settings-availability">{family.availability}</p>
    </li>
  );
}

function FamilyContent({
  family,
  token,
  onUnauthorized,
  onValidated,
}: {
  family: SettingsFamily;
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  if (family.id === "telegram") {
    return <TelegramSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />;
  }
  if (family.id === "discord") {
    return <DiscordSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />;
  }
  if (family.id === "scheduler") {
    return <SchedulerSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />;
  }
  if (family.id === "agent-model-preference") {
    return <AgentPreferencesForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />;
  }
  if (family.id === "agent-model-fallback" || family.id === "agent-context-injection" || family.id === "agent-self-improvement") {
    // W6: these agent-config families are edited in the combined Agent
    // preferences workflow above; no duplicate static form is rendered.
    return <FamilyItem family={{ ...family, availability: "Managed in the Agent preferences workflow above." }} />;
  }
  return <FamilyItem family={family} />;
}

export function SettingsView({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const tiers: SettingsTier[] = ["tier-a", "tier-b", "tier-c"];
  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        <p className="muted">
          This page manages the configuration families Workbench Settings supports. Telegram and Discord transport
          workflows are available here; the other families arrive only in separately gated slices.
        </p>
      </header>
      {tiers.map((tier) => {
        const presentation = TIER_PRESENTATION[tier];
        return (
          <section key={tier} aria-labelledby={TIER_IDS[tier]}>
            <h3 id={TIER_IDS[tier]}>{presentation.heading}</h3>
            <p className="muted">{presentation.blurb}</p>
            <ul className="settings-family-list">
              {familiesForTier(tier).map((family) => (
                <FamilyContent
                  key={family.id}
                  family={family}
                  token={token}
                  onUnauthorized={onUnauthorized}
                  onValidated={onValidated}
                />
              ))}
            </ul>
          </section>
        );
      })}
      <section aria-labelledby="settings-boundaries-heading">
        <h3 id="settings-boundaries-heading">What Settings will never do</h3>
        <ul className="settings-family-list">
          <li className="settings-family">
            <p className="muted">
              Never a generic YAML or file editor, never raw JSON, and never blanket CLI-command parity — only typed,
              validated workflows over the families above.
            </p>
          </li>
          <li className="settings-family">
            <p className="muted">
              Never provider credentials, live-session model or thinking controls, gateway token display, or changes
              to which agents this machine may run.
            </p>
          </li>
          <li className="settings-family">
            <p className="muted">
              Never a secret readback: bot tokens are write-only, and saved configuration is never rendered back.
              Saving never contacts a platform and never installs, starts, stops, or restarts a service.
            </p>
          </li>
        </ul>
      </section>
    </div>
  );
}
