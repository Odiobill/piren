import { familiesForTier, type SettingsFamily, type SettingsTier } from "./settings-inventory.js";

/**
 * W3 (0.2.0 amendment §5; ADR-0046): the static full-page Settings shell —
 * a read-only rendering of the explicit Tier A/B/C workflow inventory. It
 * has NO config values, NO status probes, NO inputs/forms/controls, NO
 * fetch, NO storage, and NO service/platform action. It only describes what
 * the separately gated W4–W6 slices will add. Everything renders from the
 * compile-time SETTINGS_INVENTORY model.
 */

const TIER_PRESENTATION: Record<SettingsTier, { heading: string; blurb: string }> = {
  "tier-a": {
    heading: "Typed configuration workflows",
    blurb:
      "These families will gain typed, validated edit workflows in later gated slices (W4–W6). None of them is available in this shell.",
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

export function SettingsView() {
  const tiers: SettingsTier[] = ["tier-a", "tier-b", "tier-c"];
  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        <p className="muted">
          This page maps the configuration families Workbench Settings will manage. Nothing on this page reads or
          changes any configuration yet — the typed workflows arrive only in separately gated slices.
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
                <FamilyItem key={family.id} family={family} />
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
