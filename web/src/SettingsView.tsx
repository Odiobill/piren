import { TelegramSettingsForm } from "./TelegramSettingsForm.js";
import { DiscordSettingsForm } from "./DiscordSettingsForm.js";
import { SchedulerSettingsForm } from "./SchedulerSettingsForm.js";
import { AgentPreferencesForm } from "./AgentPreferencesForm.js";

/**
 * S1 (workbench-ux-follow-up-design §4.1): the full-page Settings module is a
 * user-facing, authority-first page with exactly two groups:
 *
 * - **This installation** — the existing typed Telegram, Discord, and
 *   scheduler workflows over `~/.config/piren/` (machine-local).
 * - **Agents in this vault** — the existing typed Agent preferences workflow
 *   over the selected agent's `team/<agent>/config.yml` future-launch
 *   preferences (vault-owned).
 *
 * Presentation only: the typed forms and their request/response behavior are
 * unchanged; no route, API client, field, parser/core, write target, auth,
 * token handling, live Pi session, runnable policy, platform/process/service
 * action is altered. The internal tier/roadmap inventory
 * (`settings-inventory.ts`) remains implementation evidence but is no longer
 * page content: no tier/gated/later/availability roadmap copy and no
 * "What Settings will never do" section is rendered here.
 */
export function SettingsView({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        <p className="muted settings-lede">
          Piren keeps configuration in two places. This installation's machine-local settings live under{" "}
          <code>~/.config/piren/</code>. Each agent keeps its own future-launch preferences in its{" "}
          <code>config.yml</code> in the vault.
        </p>
      </header>

      <section aria-labelledby="settings-installation-heading">
        <h3 id="settings-installation-heading">This installation</h3>
        <p className="muted">
          Machine-local configuration for this machine only. Saving never contacts a platform, never starts or stops
          anything, and never displays a saved bot token.
        </p>
        <ul className="settings-family-list">
          {/* The form components are themselves the <li className="settings-family"> cards. */}
          <TelegramSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
          <DiscordSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
          <SchedulerSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
        </ul>
      </section>

      <section aria-labelledby="settings-agents-heading">
        <h3 id="settings-agents-heading">Agents in this vault</h3>
        <p className="muted">
          Durable future-launch preferences for one agent at a time, saved to that agent's <code>config.yml</code> in
          the vault. Saving never alters a conversation that is already running.
        </p>
        <ul className="settings-family-list">
          {/* The form component is itself the <li className="settings-family"> card. */}
          <AgentPreferencesForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
        </ul>
      </section>
    </div>
  );
}
