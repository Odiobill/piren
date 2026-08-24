import { useEffect, useState } from "react";
import { fetchConversationAgents, fetchTelegramSettings, saveTelegramSettings, SettingsHttpError, UnauthorizedError } from "./api";
import { parseTelegramChatIdsInput, type TelegramSettingsProjection } from "./settings-transport";
import { SaveIcon } from "./icons";

/**
 * W5 (0.2.0 amendment §5/§5.1; ADR-0046): the typed Telegram transport
 * Settings workflow. The bot token is WRITE-ONLY — a password input, empty
 * unless newly entered, never repopulated from reads, cleared on a
 * successful save, and excluded from URLs/storage/log/error/telemetry. The
 * chat-id list is validated structurally (mirroring the accepted CLI
 * contract). ST-1B: the read prefills the full non-secret allowlist values;
 * untouched fields are never resent, an explicitly cleared list sends an
 * empty replacement, and the default agent is a labelled select over the
 * gateway-resolved locally runnable roster with an explicit No-default
 * choice (null removes the declaration; a stored non-runnable agent shows a
 * bounded Not-locally-runnable state and is not resent until changed).
 * The bot token stays WRITE-ONLY. No platform contact, no service action,
 * no storage.
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
    void fetchTelegramSettings(token)
      .then((result) => {
        if (cancelled) return;
        onValidated();
        if (result.available) {
          setRead({ phase: "ready", projection: result.value });
          // ST-1B prefill: editable non-secret values (never a token).
          setChatIdsText(result.value.allowedChatIdValues.join(", "));
          setDefaultAgent(result.value.defaultAgent ?? "");
          setFeedback(result.value.feedbackEnabled ?? true);
        } else {
          setRead({ phase: "unavailable", reason: result.reason });
        }
        void fetchConversationAgents(token)
          .then((rosterResult) => {
            if (!cancelled) setRoster(rosterResult.agents.map((agent) => agent.name));
          })
          .catch(() => {
            /* Bounded: the select still renders with the stored state. */
          });
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
    if (read.phase !== "ready") return;

    const patch: { botToken?: string; allowedChatIds?: number[]; defaultAgent?: string | null; feedbackEnabled?: boolean } = {};
    const trimmedToken = botToken.trim();
    if (trimmedToken !== "") patch.botToken = trimmedToken;

    // ST-1B touch semantics: an untouched list is never resent; a touched
    // list is parsed as a full replacement (empty string clears it).
    const initialIdsText = read.projection.allowedChatIdValues.join(", ");
    if (chatIdsText.trim() !== initialIdsText) {
      if (chatIdsText.trim() === "") {
        patch.allowedChatIds = [];
      } else {
        const parsed = parseTelegramChatIdsInput(chatIdsText.trim());
        if (!parsed.ok) {
          setFieldError(parsed.error);
          return;
        }
        patch.allowedChatIds = parsed.ids;
      }
    }

    // Untouched default agent is not resent; explicit No default removes it.
    const trimmedAgent = defaultAgent.trim();
    if (trimmedAgent !== (read.projection.defaultAgent ?? "")) {
      patch.defaultAgent = trimmedAgent === "" ? null : trimmedAgent;
    }
    if (feedbackTouched) patch.feedbackEnabled = feedback;

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
            {read.projection.allowedChatIds} chat ID(s) configured. Enter a list to replace them.
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
            <select
              className="settings-form-default-agent"
              aria-label="Default agent"
              value={defaultAgent}
              onChange={(event) => setDefaultAgent(event.target.value)}
            >
              <option value="">No default agent</option>
              {roster.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {/* A stored but no-longer-runnable agent stays visible and is
                  never silently rewritten or resubmitted. */}
              {defaultAgent !== "" && !roster.includes(defaultAgent) && (
                <option value={defaultAgent}>{`${defaultAgent} - not locally runnable`}</option>
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
