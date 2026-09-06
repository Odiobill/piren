import { useEffect, useState } from "react";
import { fetchConversationAgents, fetchDiscordSettings, saveDiscordSettings, SettingsHttpError, UnauthorizedError } from "./api";
import { parseDiscordSnowflakesInput, type DiscordSettingsProjection } from "./settings-transport";
import { SaveIcon } from "./icons";
import { agentDisplayName } from "./agent-display";

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
  const [roster, setRoster] = useState<string[]>([]);
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
          // ST-1B prefill: editable non-secret snowflake values (never a token).
          setGuildIds(result.value.allowedGuildIdValues.join(", "));
          setChannelIds(result.value.allowedChannelIdValues.join(", "));
          setThreadIds(result.value.allowedThreadIdValues === null ? "" : result.value.allowedThreadIdValues.join(", "));
          setDmUserIds(result.value.allowedDmUserIdValues === null ? "" : result.value.allowedDmUserIdValues.join(", "));
          setDefaultAgent(result.value.defaultAgent ?? "");
          setFeedback(result.value.feedbackEnabled ?? true);
        } else {
          setRead({ phase: "unavailable", reason: result.reason });
        }
        // ST-1B correction: only locally runnable agents (online flag) become
        // ordinary default choices; a stored offline default keeps its bounded
        // Not-locally-runnable option. Auth failures recover through the shell.
        void fetchConversationAgents(token)
          .then((rosterResult) => {
            if (!cancelled) setRoster(rosterResult.agents.filter((agent) => agent.online).map((agent) => agent.name));
          })
          .catch((cause: unknown) => {
            if (cancelled) return;
            if (cause instanceof UnauthorizedError) onUnauthorized();
            /* Non-auth roster failures stay bounded: the select still renders
               with No-default plus any stored bounded state. */
          });
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
      defaultAgent?: string | null;
      feedbackEnabled?: boolean;
    } = {};
    const trimmedToken = botToken.trim();
    if (trimmedToken !== "") patch.botToken = trimmedToken;

    // ST-1B touch semantics: an untouched list is never resent; a touched
    // list is parsed as a full replacement (empty string clears it).
    const initial = read.phase === "ready" ? read.projection : undefined;
    const lists = [
      { text: guildIds, initialValues: initial?.allowedGuildIdValues ?? [], key: "allowedGuildIds", field: "guilds", noun: "server" },
      { text: channelIds, initialValues: initial?.allowedChannelIdValues ?? [], key: "allowedChannelIds", field: "channels", noun: "channel" },
      { text: threadIds, initialValues: initial?.allowedThreadIdValues ?? [], key: "allowedThreadIds", field: "threads", noun: "thread" },
      { text: dmUserIds, initialValues: initial?.allowedDmUserIdValues ?? [], key: "allowedDmUserIds", field: "DM users", noun: "user" },
    ] as const;
    for (const entry of lists) {
      if (entry.text.trim() === entry.initialValues.join(", ")) continue;
      const trimmed = entry.text.trim();
      if (trimmed === "") {
        // Explicitly cleared touched list: clear it through the write path.
        (patch as Record<string, unknown>)[entry.key] = [];
        continue;
      }
      const parsed = parseDiscordSnowflakesInput(trimmed, entry.field, entry.noun);
      if (!parsed.ok) {
        setFieldError(parsed.error);
        return;
      }
      (patch as Record<string, unknown>)[entry.key] = parsed.ids;
    }

    // Untouched default agent is not resent; explicit No default removes it.
    const trimmedAgent = defaultAgent.trim();
    if (initial !== undefined && trimmedAgent !== (initial.defaultAgent ?? "")) {
      patch.defaultAgent = trimmedAgent === "" ? null : trimmedAgent;
    }
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
    <li className="settings-family wb-surface">
      <div className="settings-family-header">
        <strong>Discord transport</strong>
        {/* SR-1: truthful uppercase status badge, rendered only once the
            read projection is actually available. */}
        {read.phase === "ready" && (
          <span
            className={`agent-status ${read.projection.configured ? "status-ok" : "status-muted"}`}
            role="status"
          >
            {read.projection.configured ? "Configured" : "Not configured"}
          </span>
        )}
      </div>
      {read.phase === "loading" && <p className="muted">Loading…</p>}
      {read.phase === "error" && <p className="muted" role="alert">{read.bounded}</p>}
      {read.phase === "unavailable" && <p className="muted">{read.reason}</p>}
      {read.phase === "ready" && (
        <div className="settings-form">
          <p className="muted">
            {read.projection.configured ? "Bot token configured" : "Bot token not configured"} ·{" "}
            {read.projection.allowedGuildIds} guild(s) and {read.projection.allowedChannelIds} channel(s) allowlisted.
            Enter lists to replace them. Thread and DM access stays fail-closed.
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
            Allowed server (guild) IDs (comma-separated snowflakes)
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
            <select
              className="settings-form-default-agent"
              aria-label="Default agent"
              value={defaultAgent}
              onChange={(event) => setDefaultAgent(event.target.value)}
            >
              <option value="">No default agent</option>
              {roster.map((name) => (
                <option key={name} value={name}>
                  {agentDisplayName(name)}
                </option>
              ))}
              {/* A stored but no-longer-runnable agent stays visible and is
                  never silently rewritten or resubmitted. */}
              {defaultAgent !== "" && !roster.includes(defaultAgent) && (
                <option value={defaultAgent}>{`${agentDisplayName(defaultAgent)} - not locally runnable`}</option>
              )}
            </select>
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
            <SaveIcon size={13} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </li>
  );
}
