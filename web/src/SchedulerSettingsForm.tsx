import { useEffect, useState } from "react";
import { fetchSchedulerSettings, saveSchedulerSettings, SettingsHttpError, UnauthorizedError } from "./api";
import { parseOptionalPositiveInt, type SchedulerSettingsProjection } from "./settings-transport";
import { SaveIcon } from "./icons";

/**
 * W6 (0.2.0 amendment §2/§5/§5.1; ST-1A): the typed scheduler Settings
 * workflow. The form edits only the closed scheduler inventory (the three
 * automation classes, poll/stale/concurrency, device id) — the retired
 * `scheduler.enabled` master gate is not a Settings control. A legacy-GATED
 * projection refuses every save with bounded guidance toward `piren scheduler
 * configure` (Settings never migrates or silently cleans up); a legacy-
 * IGNORED projection shows a bounded inert-key notice but saves normally.
 * It preserves unprompted/unknown fields by sending only fields the steward
 * changed. It never starts/installs/stops/reloads the scheduler, ticks,
 * refreshes heartbeats, or claims/spawns work. No storage, no service action.
 */

type ReadState =
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; bounded: string }
  | { phase: "ready"; projection: SchedulerSettingsProjection };

function saveErrorMessage(kind: SettingsHttpError["kind"]): string {
  if (kind === "conflict") return "The config changed since it was read. Re-read and retry.";
  return "The save failed; nothing was changed.";
}

export function SchedulerSettingsForm({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [read, setRead] = useState<ReadState>({ phase: "loading" });
  const [inboxTasks, setInboxTasks] = useState(false);
  const [agentCron, setAgentCron] = useState(false);
  const [scriptCron, setScriptCron] = useState(false);
  const [pollText, setPollText] = useState("");
  const [staleText, setStaleText] = useState("");
  const [concurrencyText, setConcurrencyText] = useState("");
  const [deviceText, setDeviceText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSchedulerSettings(token)
      .then((result) => {
        if (cancelled) return;
        onValidated();
        if (result.available) {
          setRead({ phase: "ready", projection: result.value });
          setInboxTasks(result.value.automation.inboxTasks);
          setAgentCron(result.value.automation.agentCron);
          setScriptCron(result.value.automation.scriptCron);
          setPollText(result.value.pollIntervalSeconds === null ? "" : String(result.value.pollIntervalSeconds));
          setStaleText(result.value.staleAfterSeconds === null ? "" : String(result.value.staleAfterSeconds));
          setConcurrencyText(result.value.maxConcurrentAgents === null ? "" : String(result.value.maxConcurrentAgents));
          setDeviceText(result.value.deviceId ?? "");
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
        setRead({ phase: "error", bounded: "Scheduler settings could not be read." });
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized, onValidated]);

  function parseNumeric(text: string, _label: string): number | null | "invalid" {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value <= 0) return "invalid";
    return value;
  }

  function handleSave(): void {
    setFieldError(null);
    setSaveError(null);
    setSaved(false);
    if (read.phase !== "ready") return;
    // ST-1A: a gated legacy block is never migrated or cleaned up here.
    if (read.projection.legacyMasterGate === "gated") return;
    const initial = read.projection;

    const poll = parseNumeric(pollText, "poll interval");
    const stale = parseNumeric(staleText, "stale-after");
    const concurrency = parseNumeric(concurrencyText, "max concurrency");
    if (typeof poll === "string" || typeof stale === "string" || typeof concurrency === "string") {
      setFieldError("Poll interval, stale-after, and max concurrency must each be a positive integer.");
      return;
    }

    const patch: {
      automation?: { inbox_tasks?: boolean; agent_cron?: boolean; script_cron?: boolean };
      pollIntervalSeconds?: number;
      staleAfterSeconds?: number;
      maxConcurrentAgents?: number;
      deviceId?: string | null;
    } = {};

    const automation: { inbox_tasks?: boolean; agent_cron?: boolean; script_cron?: boolean } = {};
    if (inboxTasks !== initial.automation.inboxTasks) automation.inbox_tasks = inboxTasks;
    if (agentCron !== initial.automation.agentCron) automation.agent_cron = agentCron;
    if (scriptCron !== initial.automation.scriptCron) automation.script_cron = scriptCron;
    if (Object.keys(automation).length > 0) patch.automation = automation;

    if (poll !== null && poll !== initial.pollIntervalSeconds) patch.pollIntervalSeconds = poll;
    if (stale !== null && stale !== initial.staleAfterSeconds) patch.staleAfterSeconds = stale;
    if (concurrency !== null && concurrency !== initial.maxConcurrentAgents) patch.maxConcurrentAgents = concurrency;

    const device = deviceText.trim();
    if (device !== (initial.deviceId ?? "")) patch.deviceId = device === "" ? null : device;

    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }

    setSaving(true);
    void saveSchedulerSettings(patch, token)
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

  return (
    <li className="settings-family">
      <strong>Scheduler automation</strong>
      {read.phase === "loading" && <p className="muted">Loading…</p>}
      {read.phase === "error" && <p className="muted" role="alert">{read.bounded}</p>}
      {read.phase === "unavailable" && <p className="muted">{read.reason}</p>}
      {read.phase === "ready" && (
        <div className="settings-form">
          <p className="muted">
            These settings affect future scheduler execution only; saving never starts, installs, stops, or reloads
            the scheduler. Fresh installs resolve everything off; the interactive conversation workflow still requires
            the inbox-task class to stay off.
          </p>
          {read.projection.legacyMasterGate === "gated" && (
            <p className="settings-scheduler-legacy-gate muted" role="alert">
              This config has a legacy retired scheduler gate. Settings cannot migrate it: all automation classes are
              held off until you run `piren scheduler configure` and confirm the migration there. Saving is disabled.
            </p>
          )}
          {read.projection.legacyMasterGate === "ignored" && (
            <p className="settings-scheduler-legacy-inert muted">
              This config still carries a retired scheduler gate key; it is ignored and never adds execution. It is
              not removed here: run `piren scheduler configure` to clean it up.
            </p>
          )}
          <label className="settings-field settings-field-checkbox">
            <input
              className="settings-scheduler-inbox"
              type="checkbox"
              checked={inboxTasks}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setInboxTasks(e.target.checked)}
            />
            Inbox task automation
          </label>
          <label className="settings-field settings-field-checkbox">
            <input
              className="settings-scheduler-agent-cron"
              type="checkbox"
              checked={agentCron}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setAgentCron(e.target.checked)}
            />
            Agent cron automation
          </label>
          <label className="settings-field settings-field-checkbox">
            <input
              className="settings-scheduler-script-cron"
              type="checkbox"
              checked={scriptCron}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setScriptCron(e.target.checked)}
            />
            Script cron automation
          </label>
          <label className="settings-field">
            Poll interval (seconds)
            <input
              className="settings-scheduler-poll"
              type="text"
              value={pollText}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setPollText(e.target.value)}
            />
          </label>
          <label className="settings-field">
            Stale-after (seconds)
            <input
              className="settings-scheduler-stale"
              type="text"
              value={staleText}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setStaleText(e.target.value)}
            />
          </label>
          <label className="settings-field">
            Max concurrent agents
            <input
              className="settings-scheduler-concurrency"
              type="text"
              value={concurrencyText}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setConcurrencyText(e.target.value)}
            />
          </label>
          <label className="settings-field">
            Device id
            <input
              className="settings-scheduler-device"
              type="text"
              value={deviceText}
              disabled={read.projection.legacyMasterGate === "gated"}
              onChange={(e) => setDeviceText(e.target.value)}
            />
          </label>
          {fieldError !== null && <p className="settings-form-error" role="alert">{fieldError}</p>}
          {saveError !== null && <p className="settings-form-save-error" role="alert">{saveError}</p>}
          {saved && <p className="settings-form-saved" role="status">Saved.</p>}
          <button
            type="button"
            className="settings-form-save button"
            disabled={saving || read.projection.legacyMasterGate === "gated"}
            onClick={handleSave}
          >
            <SaveIcon size={13} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </li>
  );
}
