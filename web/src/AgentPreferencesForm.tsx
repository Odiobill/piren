import { useEffect, useRef, useState } from "react";
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
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, PlusIcon, SaveIcon, XIcon } from "./icons";

/**
 * W6 + ST-3 (Settings contract §2.4/§4.4): the typed vault-owned agent
 * preference Settings workflow. The agent is chosen ONLY from the existing
 * locally-runnable roster via an accessible radio group of dashboard cards;
 * selection loads the redacted projection and never contacts or alters a
 * live session. The model-fallback editor is an ordered list with up/down/
 * remove controls; the saved order is the visible order. Enabling auto-switch
 * requires an explicit confirmation modal before anything writes. Each family
 * sends only changed fields (W4 merge). No provider catalog contact, no
 * storage, no service action.
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

  const [modelId, setModelId] = useState("");
  const [thinking, setThinking] = useState("");
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [fallbackAdd, setFallbackAdd] = useState("");
  const [contextMode, setContextMode] = useState("");
  const [autoNudge, setAutoNudge] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewIntervalTurns, setReviewIntervalTurns] = useState("");
  const [recentMessages, setRecentMessages] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingSaveRef = useRef<(() => void) | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const fallbackSaveRef = useRef<HTMLButtonElement>(null);

  // ST-3 correction: full modal discipline - focus moves inside on open,
  // Tab/Shift+Tab cycle within the dialog's actionable controls, and Escape
  // works wherever focus is inside. Dismissal returns focus to the fallback
  // Save button (handled by the cancel/confirm paths).
  useEffect(() => {
    if (!confirmOpen) return;
    confirmCancelRef.current?.focus();
    const dialog = confirmDialogRef.current;
    if (dialog === null) return;
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea'));
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelPendingFallbackSave();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && (index <= 0 || index === -1)) {
        event.preventDefault();
        list[list.length - 1]?.focus();
      } else if (!event.shiftKey && (index === -1 || index === list.length - 1)) {
        event.preventDefault();
        list[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen]);

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
    setConfirmOpen(false);
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
          setModels(p.modelFallback.models);
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

  function runSave(run: () => Promise<void>): void {
    setFieldError(null);
    setSaveError(null);
    setSaved(false);
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
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    runSave(() => saveAgentModel(agent, patch, token));
  }

  function requestSaveFallback(): void {
    // ST-3 correction: validate the WHOLE current declaration BEFORE any
    // confirmation opens. An empty/invalid list cannot leave auto-switch
    // enabled, so it shows the bounded error and never creates a pending save.
    if (models.length === 0 || models.some((m) => !isValidFallbackModelId(m))) {
      setFieldError("Each fallback model must be an exact provider/modelId string (for example openai/gpt-4o).");
      return;
    }
    // Nothing writes until the explicit confirmation for an enabled
    // auto-switch declaration.
    if (autoSwitch) {
      pendingSaveRef.current = performSaveFallback;
      setConfirmOpen(true);
      return;
    }
    performSaveFallback();
  }

  function performSaveFallback(): void {
    if (agent === null) return;
    const patch: { autoSwitch?: boolean; models?: string[] } = { models: [...models] };
    const initialAutoSwitch = read.phase === "ready" ? (read.projection.modelFallback.autoSwitch ?? true) : true;
    if (autoSwitch !== initialAutoSwitch) patch.autoSwitch = autoSwitch;
    runSave(() => saveAgentModelFallback(agent, patch, autoSwitch, token));
  }

  function confirmPendingFallbackSave(): void {
    setConfirmOpen(false);
    pendingSaveRef.current?.();
    pendingSaveRef.current = null;
    fallbackSaveRef.current?.focus();
  }

  function cancelPendingFallbackSave(): void {
    setConfirmOpen(false);
    pendingSaveRef.current = null;
    fallbackSaveRef.current?.focus();
  }

  function addFallbackModel(): void {
    const value = fallbackAdd.trim();
    if (value === "") return;
    if (!isValidFallbackModelId(value)) {
      setFieldError("Each fallback model must be an exact provider/modelId string (for example openai/gpt-4o).");
      return;
    }
    if (models.includes(value)) {
      setFieldError("That fallback model is already in the list.");
      return;
    }
    setModels([...models, value]);
    setFallbackAdd("");
    setFieldError(null);
  }

  function moveFallbackModel(index: number, delta: -1 | 1): void {
    const next = [...models];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const swapped = next[index]!;
    next[index] = next[target]!;
    next[target] = swapped;
    setModels(next);
  }

  function removeFallbackModel(index: number): void {
    setModels(models.filter((_, i) => i !== index));
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
    runSave(() => saveAgentContextInjection(agent, contextMode as "per_turn" | "session_start_only", token));
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
    runSave(() => saveAgentSelfImprovement(agent, patch, token));
  }

  return (
    <li className="settings-family">
      <strong>Agent preferences</strong>
      <p className="muted">
        Durable future-launch preferences only. Saving never contacts an agent, never alters a running conversation,
        and never restarts anything.
      </p>
      <div className="settings-form">
        <fieldset className="settings-agent-roster">
          <legend>Choose an agent (locally runnable)</legend>
          {(roster?.agents ?? []).filter((entry) => entry.online).length === 0 ? (
            <p className="muted" role="status">
              No locally runnable agents. Add an agent to allowed_agents in the local config with the piren command
              line tool first.
            </p>
          ) : (
            <div className="settings-agent-cards" role="radiogroup" aria-label="Locally runnable agents">
              {runnable.map((name) => (
                <label key={name} className={agent === name ? "settings-agent-card settings-agent-card-active" : "settings-agent-card"}>
                  <input
                    type="radio"
                    name="settings-agent-roster"
                    value={name}
                    checked={agent === name}
                    onChange={() => loadAgent(name)}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

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
                  <option value="off">off</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
              </label>
              <button type="button" className="settings-form-save button" disabled={saving} onClick={saveModel}>
                <SaveIcon size={13} />
                Save model
              </button>
            </section>

            <section className="settings-agent-family" aria-label="Model fallback declaration">
              <strong>Model fallback declaration</strong>
              <p className="muted">
                With an enabled declaration, the same agent continues on its declared fallback models within the same
                live session after a fully settled, zero-side-effect provider error: ordered, at most once each,
                ending when the list is exhausted. Explicit steward model selection disables it for the session.
              </p>
              <label className="settings-field settings-field-checkbox">
                <input className="settings-agent-autoswitch" type="checkbox" checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />
                Enable automatic switching
              </label>
              {/* ST-3: ordered fallback editor; visible order is saved order. */}
              {models.length > 0 && (
                <ol className="settings-agent-fallback-list">
                  {models.map((model, index) => (
                    <li key={`${model}-${index}`} className="settings-agent-fallback-row">
                      <span className="settings-agent-fallback-model">{model}</span>
                      <button
                        type="button"
                        className="settings-agent-fallback-up"
                        aria-label={`Move ${model} up`}
                        disabled={index === 0}
                        onClick={() => moveFallbackModel(index, -1)}
                      >
                        <ArrowUpIcon size={13} />
                      </button>
                      <button
                        type="button"
                        className="settings-agent-fallback-down"
                        aria-label={`Move ${model} down`}
                        disabled={index === models.length - 1}
                        onClick={() => moveFallbackModel(index, 1)}
                      >
                        <ArrowDownIcon size={13} />
                      </button>
                      <button
                        type="button"
                        className="settings-agent-fallback-remove"
                        aria-label={`Remove ${model}`}
                        onClick={() => removeFallbackModel(index)}
                      >
                        <XIcon size={13} />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="settings-agent-fallback-add-row">
                <input
                  className="settings-agent-fallback-add"
                  type="text"
                  placeholder="provider/modelId"
                  aria-label="Add fallback model"
                  value={fallbackAdd}
                  onChange={(e) => setFallbackAdd(e.target.value)}
                />
                <button type="button" className="settings-agent-fallback-add-button" aria-label="Add fallback model" onClick={addFallbackModel}>
                  <PlusIcon size={13} />
                  Add
                </button>
              </div>
              <button ref={fallbackSaveRef} type="button" className="settings-form-save button" disabled={saving} onClick={requestSaveFallback}>
                <SaveIcon size={13} />
                Save fallback
              </button>
            </section>

            <section className="settings-agent-family" aria-label="Context injection">
              <strong>Context injection</strong>
              <label className="settings-field">
                Injection mode
                <select className="settings-agent-context-mode" value={contextMode} onChange={(e) => setContextMode(e.target.value)}>
                  <option value="">Default (session_start_only)</option>
                  <option value="per_turn">per_turn</option>
                  <option value="session_start_only">session_start_only</option>
                </select>
              </label>
              <button type="button" className="settings-form-save button" disabled={saving} onClick={saveContext}>
                <SaveIcon size={13} />
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
                <SaveIcon size={13} />
                Save self-improvement
              </button>
            </section>
          </>
        )}
        {fieldError !== null && <p className="settings-form-error" role="alert">{fieldError}</p>}
        {saveError !== null && <p className="settings-form-save-error" role="alert">{saveError}</p>}
        {saved && <p className="settings-form-saved" role="status">Saved.</p>}
      </div>

      {confirmOpen && (
        <div className="settings-help-backdrop">
          <div
            ref={confirmDialogRef}
            className="settings-help-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-autoswitch-confirm-title"
          >
            <header className="settings-help-header">
              <h4 id="settings-autoswitch-confirm-title">Enable automatic switching?</h4>
              <button ref={confirmCancelRef} type="button" className="settings-help-close" aria-label="Close without saving" onClick={cancelPendingFallbackSave}>
                <XIcon size={14} />
              </button>
            </header>
            <p>Saving will leave automatic switching enabled:</p>
            <ul>
              <li>The same agent continues within its same live session after a fully settled, zero-side-effect provider error.</li>
              <li>Fallback models are tried in order, at most once each.</li>
              <li>The rotation ends when the list is exhausted.</li>
              <li>Your explicit model selection disables it for the session.</li>
            </ul>
            <p className="muted">Nothing has been written yet.</p>
            <div className="settings-agent-confirm-actions">
              <button type="button" className="settings-agent-confirm-save button" onClick={confirmPendingFallbackSave}>
                <CheckIcon size={13} />
                Confirm and save
              </button>
              <button type="button" className="settings-agent-confirm-cancel button" onClick={cancelPendingFallbackSave}>
                <XIcon size={13} />
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
