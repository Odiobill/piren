import { useEffect, useState } from "react";
import { fetchSchedulerSettings, saveSchedulerSettings, SettingsHttpError, UnauthorizedError } from "./api";
import { parseOptionalPositiveInt, type SchedulerSettingsProjection } from "./settings-transport";
import { agentDisplayName } from "./agent-display";
import { SaveIcon } from "./icons";

/**
 * W6 (0.2.0 amendment §2/§5/§5.1; ST-1A) + 0.2.5 S7: the typed scheduler
 * Settings workflow. The form edits only the closed scheduler inventory (the
 * three automation classes, poll/stale/concurrency, device id, and the
 * per-class runnable-agent scope) — the retired `scheduler.enabled` master
 * gate is not a Settings control. A legacy-GATED projection refuses every
 * save with bounded guidance toward `piren scheduler configure` (Settings
 * never migrates or silently cleans up); a legacy-IGNORED projection shows a
 * bounded inert-key notice but saves normally. It preserves unprompted/
 * unknown fields by sending only fields the steward changed. The agent-scope
 * editor is presentation-only: effective sets come from the gateway's
 * authoritative resolver, visible copy uses S6 display names while values,
 * state, and requests stay canonical lowercase, and a diff-only save sends
 * only explicitly changed classes (all runnable selected -> null = clear the
 * recognized narrowing; otherwise the exact selected canonical array,
 * including [] = none). It never starts/installs/stops/reloads the scheduler,
 * ticks, refreshes heartbeats, or claims/spawns work. No storage, no service
 * action.
 */

type ScopeClass = "inbox_tasks" | "agent_cron" | "script_cron";

const SCOPE_CLASSES: ReadonlyArray<{ key: ScopeClass; groupClass: string; label: string }> = [
  { key: "inbox_tasks", groupClass: "inbox-tasks", label: "Inbox tasks" },
  { key: "agent_cron", groupClass: "agent-cron", label: "Agent cron" },
  { key: "script_cron", groupClass: "script-cron", label: "Script cron" },
];

type ScopeSelection = Record<ScopeClass, string[]>;

function emptyScopeSelection(): ScopeSelection {
  return { inbox_tasks: [], agent_cron: [], script_cron: [] };
}

function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

type ReadState =
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; bounded: string }
  | {
      phase: "ready";
      projection: SchedulerSettingsProjection;
      runnableAgents: string[];
      agentScopeWarnings: string[];
      initialScope: ScopeSelection;
    };

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
  const [scope, setScope] = useState<ScopeSelection>(emptyScopeSelection());
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
          const { value, runnableAgents, agentScopeWarnings } = result;
          const initialScope: ScopeSelection = {
            inbox_tasks: value.agentScope.inboxTasks ?? runnableAgents,
            agent_cron: value.agentScope.agentCron ?? runnableAgents,
            script_cron: value.agentScope.scriptCron ?? runnableAgents,
          };
          setRead({ phase: "ready", projection: value, runnableAgents, agentScopeWarnings, initialScope });
          setInboxTasks(value.automation.inboxTasks);
          setAgentCron(value.automation.agentCron);
          setScriptCron(value.automation.scriptCron);
          setPollText(value.pollIntervalSeconds === null ? "" : String(value.pollIntervalSeconds));
          setStaleText(value.staleAfterSeconds === null ? "" : String(value.staleAfterSeconds));
          setConcurrencyText(value.maxConcurrentAgents === null ? "" : String(value.maxConcurrentAgents));
          setDeviceText(value.deviceId ?? "");
          setScope({
            inbox_tasks: [...initialScope.inbox_tasks],
            agent_cron: [...initialScope.agent_cron],
            script_cron: [...initialScope.script_cron],
          });
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

  function toggleScopeAgent(classKey: ScopeClass, name: string, checked: boolean): void {
    setScope((prev) => {
      const current = prev[classKey];
      const next = checked
        ? current.includes(name)
          ? current
          : [...current, name]
        : current.filter((entry) => entry !== name);
      return { ...prev, [classKey]: next };
    });
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
      agentScope?: { inbox_tasks?: string[] | null; agent_cron?: string[] | null; script_cron?: string[] | null };
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

    // S7 diff-only scope save: an untouched class sends nothing; a changed
    // class sends null when every runnable agent is selected (clearing the
    // recognized narrowing covers current AND future runnable agents), and
    // otherwise the exact selected canonical array (roster-ordered, [] = none).
    const roster = read.runnableAgents;
    const agentScopePatch: NonNullable<
      NonNullable<typeof patch.agentScope>
    > = {};
    for (const { key } of SCOPE_CLASSES) {
      const selected = roster.filter((name) => scope[key].includes(name));
      if (sameSelection(read.initialScope[key], selected)) continue;
      agentScopePatch[key] = selected.length === roster.length ? null : selected;
    }
    if (Object.keys(agentScopePatch).length > 0) patch.agentScope = agentScopePatch;

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
      <div className="settings-family-header">
        <strong>Scheduler automation</strong>
        {/* SR-1: truthful uppercase status badge over the existing bounded
            `present` signal — whether a scheduler block is actually declared,
            never whether a process runs. Rendered only in the ready phase. */}
        {read.phase === "ready" && (
          <span
            className={`agent-status ${read.projection.present ? "status-ok" : "status-muted"}`}
            role="status"
          >
            {read.projection.present ? "Configured" : "Not configured"}
          </span>
        )}
      </div>
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
          {SCOPE_CLASSES.map(({ key, groupClass, label }) => (
            <fieldset
              key={key}
              className={`settings-scheduler-scope-group settings-scheduler-scope-${groupClass}`}
            >
              <legend>{label}: eligible agents</legend>
              {read.runnableAgents.length === 0 ? (
                <p className="muted">No runnable agents.</p>
              ) : (
                read.runnableAgents.map((name) => (
                  <label key={name} className="settings-field settings-field-checkbox">
                    <input
                      className="settings-scheduler-scope-agent"
                      type="checkbox"
                      value={name}
                      checked={scope[key].includes(name)}
                      disabled={read.projection.legacyMasterGate === "gated"}
                      onChange={(e) => toggleScopeAgent(key, name, e.target.checked)}
                    />
                    {agentDisplayName(name)}
                  </label>
                ))
              )}
            </fieldset>
          ))}
          {read.agentScopeWarnings.length > 0 && (
            <div className="settings-scheduler-scope-warnings muted">
              {read.agentScopeWarnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </div>
          )}
          <label className="settings-field">
            Poll interval (seconds)
            <input
              className="settings-scheduler-poll"
              type="text"
              value={pollText}
              placeholder={read.projection.pollIntervalSeconds === null ? "Default: 30" : ""}
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
              placeholder={read.projection.staleAfterSeconds === null ? "Default: 300" : ""}
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
              placeholder={read.projection.maxConcurrentAgents === null ? "Default: 1" : ""}
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
