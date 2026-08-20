import { useEffect, useState } from "react";
import { fetchDiscordSettings, saveDiscordSettings, SettingsHttpError, UnauthorizedError } from "./api";
import { parseDiscordSnowflakesInput, type DiscordSettingsProjection } from "./settings-transport";

/**
 * W5 (0.2.0 amendment §5/§5.1; ADR-0046): the typed Discord transport
 * Settings workflow. The bot token is WRITE-ONLY (password, empty unless
 * newly entered, never repopulated, cleared on success). The server/channel/
 * thread/DM allowlists are validated structurally (15-22 digit snowflakes);
 * thread and DM lists are optional (fail-closed semantics preserved). The
 * read only returns counts + default agent + feedback, so lists are entered
 * fresh to replace. No platform contact, no service action, no storage.
 */

type ReadState =
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; bounded: string }
  | { phase: "ready"; projection: DiscordSettingsProjection };

function saveErrorMessage(kind: SettingsHttpError["kind"]): string {
  if (kind === "conflict") return "The config changed since it was read. Re-read and retry.";
  return "The save failed; nothing was changed.";
}

export function DiscordSettingsForm({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [read, setRead] = useState<ReadState>({ phase: "loading" });
  const [botToken, setBotToken] = useState("");
  const [guildIds, setGuildIds] = useState("");
  const [channelIds, setChannelIds] = useState("");
  const [threadIds, setThreadIds] = useState("");
  const [dmUserIds, setDmUserIds] = useState("");
  const [defaultAgent, setDefaultAgent] = useState("");
  const [feedback, setFeedback] = useState(true);
  // Preserve an absent feedback declaration unless the steward changes it.
  const [feedbackTouched, setFeedbackTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDiscordSettings(token)
      .then((result) => {
        if (cancelled) return;
        onValidated();
        if (result.available) {
          setRead({ phase: "ready", projection: result.value });
          setDefaultAgent(result.value.defaultAgent ?? "");
          setFeedback(result.value.feedbackEnabled ?? true);
        } else {
          setRead({ phase: "unavailable", reason: result.reason });
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setRead({ phase: "error", bounded: "Discord settings could not be read." });
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized, onValidated]);

  function handleSave(): void {
    setFieldError(null);
    setSaveError(null);
    setSaved(false);

    const patch: {
      botToken?: string;
      allowedGuildIds?: string[];
      allowedChannelIds?: string[];
      allowedThreadIds?: string[];
      allowedDmUserIds?: string[];
      defaultAgent?: string;
      feedbackEnabled?: boolean;
    } = {};
    const trimmedToken = botToken.trim();
    if (trimmedToken !== "") patch.botToken = trimmedToken;

    const required = [
      { text: guildIds, key: "allowedGuildIds", field: "guilds", noun: "server" },
      { text: channelIds, key: "allowedChannelIds", field: "channels", noun: "channel" },
    ] as const;
    for (const entry of required) {
      const trimmed = entry.text.trim();
      if (trimmed === "") continue;
      const parsed = parseDiscordSnowflakesInput(trimmed, entry.field, entry.noun);
      if (!parsed.ok) {
        setFieldError(parsed.error);
        return;
      }
      (patch as Record<string, unknown>)[entry.key] = parsed.ids;
    }

    const optional = [
      { text: threadIds, key: "allowedThreadIds", field: "threads", noun: "thread" },
      { text: dmUserIds, key: "allowedDmUserIds", field: "DM users", noun: "user" },
    ] as const;
    for (const entry of optional) {
      const parsed = parseDiscordSnowflakesInput(entry.text, entry.field, entry.noun, { optional: true });
      if (!parsed.ok) {
        setFieldError(parsed.error);
        return;
      }
      if (parsed.ids.length > 0) (patch as Record<string, unknown>)[entry.key] = parsed.ids;
    }

    const trimmedAgent = defaultAgent.trim();
    if (trimmedAgent !== "") patch.defaultAgent = trimmedAgent;
    if (feedbackTouched) patch.feedbackEnabled = feedback;

    setSaving(true);
    void saveDiscordSettings(patch, token)
      .then(() => {
        onValidated();
        setBotToken("");
        setSaved(true);
      })
      .catch((cause: unknown) => {
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (cause instanceof SettingsHttpError) setSaveError(saveErrorMessage(cause.kind));
        else setSaveError("The save failed; nothing was changed.");
      })
      .finally(() => setSaving(false));
  }

  return (
    <li className="settings-family">
      <strong>Discord transport</strong>
      {read.phase === "loading" && <p className="muted">Loading…</p>}
      {read.phase === "error" && <p className="muted" role="alert">{read.bounded}</p>}
      {read.phase === "unavailable" && <p className="muted">{read.reason}</p>}
      {read.phase === "ready" && (
        <div className="settings-form">
          <p className="muted">
            {read.projection.configured ? "Bot token configured" : "Bot token not configured"} ·{" "}
            {read.projection.allowedGuildIds} guild(s) and {read.projection.allowedChannelIds} channel(s) allowlisted —
            enter lists to replace them. Thread and DM access stays fail-closed.
          </p>
          <label className="settings-field">
            Bot token (write-only, never displayed)
            <input
              className="settings-form-token"
              type="password"
              autoComplete="new-password"
              aria-label="Bot token"
              value={botToken}
              placeholder={read.projection.configured ? "Enter a new token to replace the current one" : "Enter a token"}
              onChange={(event) => setBotToken(event.target.value)}
            />
          </label>
          <label className="settings-field">
            Allowed server (guild) IDs — comma-separated snowflakes
            <input
              className="settings-form-guild-ids"
              type="text"
              aria-label="Allowed guild IDs"
              value={guildIds}
              onChange={(event) => setGuildIds(event.target.value)}
            />
          </label>
          <label className="settings-field">
            Allowed channel IDs
            <input
              className="settings-form-channel-ids"
              type="text"
              aria-label="Allowed channel IDs"
              value={channelIds}
              onChange={(event) => setChannelIds(event.target.value)}
            />
          </label>
          <label className="settings-field">
            Allowed thread IDs (optional)
            <input
              className="settings-form-thread-ids"
              type="text"
              aria-label="Allowed thread IDs"
              value={threadIds}
              onChange={(event) => setThreadIds(event.target.value)}
            />
          </label>
          <label className="settings-field">
            Allowed DM user IDs (optional)
            <input
              className="settings-form-dm-ids"
              type="text"
              aria-label="Allowed DM user IDs"
              value={dmUserIds}
              onChange={(event) => setDmUserIds(event.target.value)}
            />
          </label>
          <label className="settings-field">
            Default agent
            <input
              className="settings-form-default-agent"
              type="text"
              aria-label="Default agent"
              value={defaultAgent}
              onChange={(event) => setDefaultAgent(event.target.value)}
            />
          </label>
          <label className="settings-field settings-field-checkbox">
            <input
              className="settings-form-feedback"
              type="checkbox"
              checked={feedback}
              onChange={(event) => {
                setFeedback(event.target.checked);
                setFeedbackTouched(true);
              }}
            />
            Transport feedback (receipt reactions and typing indicator)
          </label>
          {fieldError !== null && <p className="settings-form-error" role="alert">{fieldError}</p>}
          {saveError !== null && <p className="settings-form-save-error" role="alert">{saveError}</p>}
          {saved && <p className="settings-form-saved" role="status">Saved.</p>}
          <button type="button" className="settings-form-save button" disabled={saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </li>
  );
}
