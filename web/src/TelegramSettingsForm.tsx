import { useEffect, useState } from "react";
import { fetchTelegramSettings, saveTelegramSettings, SettingsHttpError, UnauthorizedError } from "./api";
import { parseTelegramChatIdsInput, type TelegramSettingsProjection } from "./settings-transport";

/**
 * W5 (0.2.0 amendment §5/§5.1; ADR-0046): the typed Telegram transport
 * Settings workflow. The bot token is WRITE-ONLY — a password input, empty
 * unless newly entered, never repopulated from reads, cleared on a
 * successful save, and excluded from URLs/storage/log/error/telemetry. The
 * chat-id list is validated structurally (mirroring the accepted CLI
 * contract); the read only ever returns a count + default agent + feedback,
 * so the list is entered fresh to replace. No platform contact, no service
 * action, no storage.
 */

type ReadState =
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; bounded: string }
  | { phase: "ready"; projection: TelegramSettingsProjection };

function saveErrorMessage(kind: SettingsHttpError["kind"]): string {
  if (kind === "conflict") return "The config changed since it was read. Re-read and retry.";
  return "The save failed; nothing was changed.";
}

export function TelegramSettingsForm({
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
  const [chatIdsText, setChatIdsText] = useState("");
  const [defaultAgent, setDefaultAgent] = useState("");
  const [feedback, setFeedback] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchTelegramSettings(token)
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
        setRead({ phase: "error", bounded: "Telegram settings could not be read." });
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized, onValidated]);

  function handleSave(): void {
    setFieldError(null);
    setSaveError(null);
    setSaved(false);

    const patch: { botToken?: string; allowedChatIds?: number[]; defaultAgent?: string; feedbackEnabled?: boolean } = {};
    const trimmedToken = botToken.trim();
    if (trimmedToken !== "") patch.botToken = trimmedToken;

    const trimmedIds = chatIdsText.trim();
    if (trimmedIds !== "") {
      const parsed = parseTelegramChatIdsInput(trimmedIds);
      if (!parsed.ok) {
        setFieldError(parsed.error);
        return;
      }
      patch.allowedChatIds = parsed.ids;
    }

    const trimmedAgent = defaultAgent.trim();
    if (trimmedAgent !== "") patch.defaultAgent = trimmedAgent;
    patch.feedbackEnabled = feedback;

    setSaving(true);
    void saveTelegramSettings(patch, token)
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
      <strong>Telegram transport</strong>
      {read.phase === "loading" && <p className="muted">Loading…</p>}
      {read.phase === "error" && <p className="muted" role="alert">{read.bounded}</p>}
      {read.phase === "unavailable" && <p className="muted">{read.reason}</p>}
      {read.phase === "ready" && (
        <div className="settings-form">
          <p className="muted">
            {read.projection.configured ? "Bot token configured" : "Bot token not configured"} ·{" "}
            {read.projection.allowedChatIds} chat ID(s) configured — enter a list to replace them.
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
            Allowed chat IDs (comma-separated integers; group IDs negative)
            <input
              className="settings-form-chat-ids"
              type="text"
              aria-label="Allowed chat IDs"
              value={chatIdsText}
              onChange={(event) => setChatIdsText(event.target.value)}
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
              onChange={(event) => setFeedback(event.target.checked)}
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
