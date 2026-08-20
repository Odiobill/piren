import { useEffect, useState } from "react";
import {
  fetchAgentPreferences,
  fetchConversationAgents,
  saveAgentContextInjection,
  saveAgentModel,
  saveAgentModelFallback,
  saveAgentSelfImprovement,
  SettingsHttpError,
  UnauthorizedError,
} from "./api";
import {
  parseOptionalPositiveInt,
  isValidContextInjectionMode,
  isValidFallbackModelId,
  isValidThinkingLevel,
  type AgentPreferencesProjection,
} from "./settings-transport";

/**
 * W6 (0.2.0 amendment §5/§5.1): the typed vault-owned agent-preference
 * Settings workflow. The agent is chosen ONLY from the existing locally-
 * runnable roster. Each family edits its own closed declaration and sends
 * only changed fields (preserving unprompted/unknown keys via the W4 merge).
 * Durable future-launch preferences only — saving never alters a live Pi
 * session. Enabling model-fallback auto-switch requires a separate explicit
 * confirmation. No provider catalog/preflight contact, no storage, no
 * service action.
 */

type Roster = { agents: { name: string; online: boolean }[] };
type ReadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; bounded: string }
  | { phase: "ready"; projection: AgentPreferencesProjection };

function saveErrorMessage(kind: SettingsHttpError["kind"]): string {
  if (kind === "conflict") return "The config changed since it was read. Re-read and retry.";
  return "The save failed; nothing was changed.";
}

export function AgentPreferencesForm({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [read, setRead] = useState<ReadState>({ phase: "idle" });

  // Model preference fields.
  const [modelId, setModelId] = useState("");
  const [thinking, setThinking] = useState("");
  // Fallback fields.
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [modelsText, setModelsText] = useState("");
  // Context injection.
  const [contextMode, setContextMode] = useState("");
  // Self-improvement.
  const [autoNudge, setAutoNudge] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewIntervalTurns, setReviewIntervalTurns] = useState("");
  const [recentMessages, setRecentMessages] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");

  const [confirmAutoSwitch, setConfirmAutoSwitch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchConversationAgents(token)
      .then((result) => {
        if (cancelled) return;
        onValidated();
        setRoster(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setFieldError("The agent roster could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized, onValidated]);

  function loadAgent(nextAgent: string): void {
    setAgent(nextAgent);
    setRead({ phase: "loading" });
    setConfirmAutoSwitch(false);
    setFieldError(null);
    setSaveError(null);
    setSaved(false);
    void fetchAgentPreferences(nextAgent, token)
      .then((result) => {
        if (result.available) {
          setRead({ phase: "ready", projection: result.value });
          const p = result.value;
          setModelId(p.model.id ?? "");
          setThinking(p.model.thinking ?? "");
          setAutoSwitch(p.modelFallback.autoSwitch ?? true);
          setModelsText(p.modelFallback.models.join(", "));
          setContextMode(p.contextInjection.mode ?? "");
          setAutoNudge(p.selfImprovement.autoNudge ?? false);
          setReviewEnabled(p.selfImprovement.reviewLoopEnabled ?? false);
          setReviewIntervalTurns(p.selfImprovement.reviewLoop.intervalTurns === null ? "" : String(p.selfImprovement.reviewLoop.intervalTurns));
          setRecentMessages(p.selfImprovement.reviewLoop.recentMessages === null ? "" : String(p.selfImprovement.reviewLoop.recentMessages));
          setTimeoutMs(p.selfImprovement.reviewLoop.timeoutMs === null ? "" : String(p.selfImprovement.reviewLoop.timeoutMs));
        } else {
          setRead({ phase: "unavailable", reason: result.reason });
        }
      })
      .catch((cause: unknown) => {
        if (cause instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setRead({ phase: "error", bounded: "Agent preferences could not be read." });
      });
  }

  const runnable = (roster?.agents ?? []).filter((entry) => entry.online).map((entry) => entry.name);

  function runSave(run: () => Promise<void>, confirm: boolean): void {
    setFieldError(null);
    setSaveError(null);
    setSaved(false);
    if (confirm && !confirmAutoSwitch) {
      setFieldError("Please confirm the enabled auto-switch declaration before saving.");
      return;
    }
    setSaving(true);
    void run()
      .then(() => {
        onValidated();
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

  function saveModel(): void {
    if (agent === null) return;
    const patch: { id?: string; thinking?: string } = {};
    if (read.phase === "ready") {
      const initial = read.projection;
      if (modelId.trim() !== "" && modelId.trim() !== (initial.model.id ?? "")) patch.id = modelId.trim();
      if (thinking !== "" && thinking !== (initial.model.thinking ?? "")) patch.thinking = thinking;
    } else if (modelId.trim() !== "") patch.id = modelId.trim();
    if (thinking !== "" && patch.thinking === undefined && read.phase !== "ready") patch.thinking = thinking;
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    runSave(() => saveAgentModel(agent, patch, token), false);
  }

  function saveFallback(): void {
    if (agent === null) return;
    const trimmedModels = modelsText.trim();
    if (trimmedModels === "") {
      setFieldError("At least one fallback model is required.");
      return;
    }
    const models = trimmedModels.split(",").map((m) => m.trim()).filter((m) => m !== "");
    if (models.length === 0 || models.some((m) => !isValidFallbackModelId(m))) {
      setFieldError("Each fallback model must be an exact provider/modelId string (for example openai/gpt-4o).");
      return;
    }
    // The fallback declaration requires the models list; it is always sent
    // as part of the closed declaration.
    const patch: { autoSwitch?: boolean; models?: string[] } = { models };
    const initialAutoSwitch = read.phase === "ready" ? (read.projection.modelFallback.autoSwitch ?? true) : true;
    if (autoSwitch !== initialAutoSwitch) patch.autoSwitch = autoSwitch;
    // The resulting auto-switch state is the form's checkbox; enabling it
    // requires the explicit confirmation.
    runSave(() => saveAgentModelFallback(agent, patch, autoSwitch, token), autoSwitch);
  }

  function saveContext(): void {
    if (agent === null) return;
    if (contextMode === "") {
      setSaved(true);
      return;
    }
    if (!isValidContextInjectionMode(contextMode)) {
      setFieldError("Choose a valid context-injection mode.");
      return;
    }
    runSave(() => saveAgentContextInjection(agent, contextMode as "per_turn" | "session_start_only", token), false);
  }

  function saveSelfImprovement(): void {
    if (agent === null) return;
    const patch: {
      autoNudge?: boolean;
      reviewLoopEnabled?: boolean;
      reviewLoopIntervalTurns?: number;
      reviewLoopRecentMessages?: number;
      reviewLoopTimeoutMs?: number;
    } = {};
    const initial = read.phase === "ready" ? read.projection.selfImprovement : null;
    if (autoNudge !== (initial?.autoNudge ?? false)) patch.autoNudge = autoNudge;
    if (reviewEnabled !== (initial?.reviewLoopEnabled ?? false)) patch.reviewLoopEnabled = reviewEnabled;

    const numerics: Array<[string, string, "reviewLoopIntervalTurns" | "reviewLoopRecentMessages" | "reviewLoopTimeoutMs", number | null]> = [
      [reviewIntervalTurns, "review interval", "reviewLoopIntervalTurns", initial?.reviewLoop.intervalTurns ?? null],
      [recentMessages, "recent messages", "reviewLoopRecentMessages", initial?.reviewLoop.recentMessages ?? null],
      [timeoutMs, "review timeout", "reviewLoopTimeoutMs", initial?.reviewLoop.timeoutMs ?? null],
    ];
    for (const [text, label, key, initialValue] of numerics) {
      const parsed = parseOptionalPositiveInt(text);
      if (parsed === "invalid") {
        setFieldError(`${label} must be a positive integer.`);
        return;
      }
      if (parsed !== null && parsed !== initialValue) patch[key] = parsed;
    }

    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    runSave(() => saveAgentSelfImprovement(agent, patch, token), false);
  }

  return (
    <li className="settings-family">
      <strong>Agent preferences</strong>
      <p className="muted">
        Durable preferences for future agent launches, saved only through the agent-config parse contract. These are
        not live-session controls and never alter a running conversation.
      </p>
      <div className="settings-form">
        <label className="settings-field">
          Agent (locally runnable)
          <select className="settings-agent-select" value={agent ?? ""} onChange={(e) => loadAgent(e.target.value)}>
            <option value="" disabled>
              Choose an agent
            </option>
            {runnable.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {read.phase === "loading" && <p className="muted">Loading…</p>}
        {read.phase === "error" && <p className="muted" role="alert">{read.bounded}</p>}
        {read.phase === "unavailable" && <p className="muted">{read.reason}</p>}
        {read.phase === "ready" && (
          <>
            <section className="settings-agent-family" aria-label="Model preference">
              <strong>Model preference</strong>
              <label className="settings-field">
                Model id (provider/modelId)
                <input className="settings-agent-model-id" type="text" value={modelId} onChange={(e) => setModelId(e.target.value)} />
              </label>
              <label className="settings-field">
                Thinking level
                <select className="settings-agent-thinking" value={thinking} onChange={(e) => setThinking(e.target.value)}>
                  <option value="">Default</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <button type="button" className="settings-form-save button" disabled={saving} onClick={saveModel}>
                Save model
              </button>
            </section>

            <section className="settings-agent-family" aria-label="Model fallback declaration">
              <strong>Model fallback declaration</strong>
              <p className="muted">
                Already delivered: with an enabled declaration, the same agent continues on its declared fallback
                models within the same live session after a fully settled, zero-side-effect provider error — ordered,
                at-most-once, terminal on exhaustion. Explicit steward model selection disables it for the session.
              </p>
              <label className="settings-field settings-field-checkbox">
                <input className="settings-agent-autoswitch" type="checkbox" checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />
                Enable automatic switching
              </label>
              <label className="settings-field">
                Fallback models (comma-separated provider/modelId)
                <input className="settings-agent-fallback-models" type="text" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
              </label>
              {autoSwitch && (
                <label className="settings-field settings-field-checkbox">
                  <input
                    className="settings-agent-confirm"
                    type="checkbox"
                    checked={confirmAutoSwitch}
                    onChange={(e) => setConfirmAutoSwitch(e.target.checked)}
                  />
                  I confirm the bounded same-agent, same-live-session auto-switch continuation described above.
                </label>
              )}
              <button type="button" className="settings-form-save button" disabled={saving} onClick={saveFallback}>
                Save fallback
              </button>
            </section>

            <section className="settings-agent-family" aria-label="Context injection">
              <strong>Context injection</strong>
              <label className="settings-field">
                Injection mode
                <select className="settings-agent-context-mode" value={contextMode} onChange={(e) => setContextMode(e.target.value)}>
                  <option value="">Default</option>
                  <option value="per_turn">per_turn</option>
                  <option value="session_start_only">session_start_only</option>
                </select>
              </label>
              <button type="button" className="settings-form-save button" disabled={saving} onClick={saveContext}>
                Save context injection
              </button>
            </section>

            <section className="settings-agent-family" aria-label="Self-improvement signals">
              <strong>Self-improvement signals</strong>
              <label className="settings-field settings-field-checkbox">
                <input className="settings-agent-autonudge" type="checkbox" checked={autoNudge} onChange={(e) => setAutoNudge(e.target.checked)} />
                Correction auto-nudge
              </label>
              <label className="settings-field settings-field-checkbox">
                <input className="settings-agent-review-enabled" type="checkbox" checked={reviewEnabled} onChange={(e) => setReviewEnabled(e.target.checked)} />
                Review loop
              </label>
              <label className="settings-field">
                Review interval (turns)
                <input className="settings-agent-review-interval" type="text" value={reviewIntervalTurns} onChange={(e) => setReviewIntervalTurns(e.target.value)} />
              </label>
              <label className="settings-field">
                Recent messages
                <input className="settings-agent-review-recent" type="text" value={recentMessages} onChange={(e) => setRecentMessages(e.target.value)} />
              </label>
              <label className="settings-field">
                Review timeout (ms)
                <input className="settings-agent-review-timeout" type="text" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
              </label>
              <button type="button" className="settings-form-save button" disabled={saving} onClick={saveSelfImprovement}>
                Save self-improvement
              </button>
            </section>
          </>
        )}
        {fieldError !== null && <p className="settings-form-error" role="alert">{fieldError}</p>}
        {saveError !== null && <p className="settings-form-save-error" role="alert">{saveError}</p>}
        {saved && <p className="settings-form-saved" role="status">Saved.</p>}
      </div>
    </li>
  );
}
