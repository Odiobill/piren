import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { TelegramSettingsForm } from "./TelegramSettingsForm.js";
import { DiscordSettingsForm } from "./DiscordSettingsForm.js";
import { SchedulerSettingsForm } from "./SchedulerSettingsForm.js";
import { AgentPreferencesForm } from "./AgentPreferencesForm.js";
import { SettingsHelpControl } from "./SettingsHelpControl.js";
import { FolderIcon, GearIcon, HomeIcon } from "./icons.js";

/**
 * ST-2A (Settings contract §§2.1/4.1): a welcoming tabbed Settings shell with
 * exactly three accessible tabs in fixed order: This installation, Agent
 * settings, Agent groups. Default is This installation on every fresh load;
 * view state is component-local (no browser persistence). WAI-ARIA
 * tablist/tab/tabpanel semantics: arrow/Home/End move tab focus only,
 * Enter/Space activates (native button activation), and focus stays on the
 * active tab. Panels keep the existing typed forms and their behavior
 * unchanged; the Agent groups tab is an honest introduction only (no list,
 * routes, or actions until the later typed group workflow).
 */

type SettingsTabId = "installation" | "agents" | "groups";

const TABS: Array<{ id: SettingsTabId; label: string; Icon: (props: { size?: number }) => ReactElement }> = [
  { id: "installation", label: "This installation", Icon: HomeIcon },
  { id: "agents", label: "Agent settings", Icon: GearIcon },
  { id: "groups", label: "Agent groups", Icon: FolderIcon },
];

const TELEGRAM_HELP = {
  transport: "Telegram",
  title: "How to set up a Telegram bot",
  steps: [
    "Open Telegram and message the BotFather account.",
    "Send /newbot and follow the prompts to choose a name and username.",
    "Copy the bot token it gives you. Keep it private.",
    "Paste the token into the Bot token field here and save.",
    "Message your new bot once from your account so its chat ID exists.",
    "Add that chat ID to the Allowed chat IDs list to authorize it.",
  ],
};

const DISCORD_HELP = {
  transport: "Discord",
  title: "How to set up a Discord bot",
  steps: [
    "Open the Discord developer portal and create a New Application.",
    "In the Bot page, copy the bot token. Keep it private.",
    "Paste the token into the Bot token field here and save.",
    "Use OAuth2 URL Generator with the bot scope to invite it to your server.",
    "Enable Developer Mode in Discord, then right-click channels to copy IDs.",
    "Add your server ID and channel IDs to the allowlist fields here.",
  ],
};

export function SettingsView({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("installation");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    // Focus movement only; activation stays explicit (Enter/Space/click).
    const next = tabRefs.current[nextIndex];
    next?.focus();
  }

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        <p className="muted settings-lede">
          Welcome. Configure this installation, set how each agent launches in future conversations, and browse the
          vault's agent groups. Machine-local configuration lives under <code>~/.config/piren/</code>; agent
          preferences live in each agent's <code>config.yml</code> in the vault.
        </p>
      </header>

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={activeTab === tab.id ? "settings-tab settings-tab-active" : "settings-tab"}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.Icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* All panels stay mounted so typed forms keep their data/loading
          behavior exactly as before; only the active panel is exposed. */}
      <section
        role="tabpanel"
        id="settings-panel-installation"
        aria-labelledby="settings-tab-installation"
        hidden={activeTab !== "installation"}
      >
        <h3 id="settings-installation-heading">This installation</h3>
        <p className="muted">
          Machine-local configuration for this machine only. Saving never contacts a platform, never starts or stops
          anything, and never displays a saved bot token.
        </p>
        <div className="settings-help-row">
          <SettingsHelpControl topic={TELEGRAM_HELP} />
          <SettingsHelpControl topic={DISCORD_HELP} />
        </div>
        <ul className="settings-family-list">
          {/* The form components are themselves the <li className="settings-family"> cards. */}
          <TelegramSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
          <DiscordSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
          <SchedulerSettingsForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
        </ul>
      </section>

      <section role="tabpanel" id="settings-panel-agents" aria-labelledby="settings-tab-agents" hidden={activeTab !== "agents"}>
        <h3 id="settings-agents-heading">Agent settings</h3>
        <p className="muted">
          Durable future-launch preferences for one agent at a time, saved to that agent's <code>config.yml</code> in
          the vault. Saving never alters a conversation that is already running.
        </p>
        <ul className="settings-family-list">
          {/* The form component is itself the <li className="settings-family"> card. */}
          <AgentPreferencesForm token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
        </ul>
      </section>

      <section role="tabpanel" id="settings-panel-groups" aria-labelledby="settings-tab-groups" hidden={activeTab !== "groups"}>
        <h3 id="settings-groups-heading">Agent groups</h3>
        <p className="muted">
          Agent groups describe vault-owned team topology: which agents belong together for skills and fallback
          ordering. Groups live in <code>agent-groups/</code> in the vault.
        </p>
        <p className="muted">
          Group management is not available yet; there is nothing to configure here in this update. Today you can
          manage groups with the <code>piren group</code> command line tool.
        </p>
      </section>
    </div>
  );
}
