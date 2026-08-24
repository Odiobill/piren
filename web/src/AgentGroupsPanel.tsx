import { useEffect, useRef, useState } from "react";
import {
  fetchGroupDetail,
  fetchGroupsList,
  fetchGroupsValidation,
  postGroupAction,
  UnauthorizedError,
  type GroupDetailDto,
  type GroupRosterEntryDto,
  type GroupSummaryDto,
  type GroupValidationIssueDto,
} from "./groups-api";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClipboardIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SaveIcon,
  XIcon,
} from "./icons";

/**
 * ST-4: typed vault-owned Agent Groups workflows. Groups may contain locally
 * non-runnable agents (marked, never actionable). Membership choices come
 * ONLY from the vault-defined roster. Create/remove-agent and fallback-set
 * require explicit labelled confirmation modals with full focus discipline;
 * conflict re-reads; a typed 401 hands over to the shell. No local-policy
 * access, no persistence.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready" };

type ValidationState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; issues: GroupValidationIssueDto[] };

interface PendingConfirm {
  title: string;
  body: string;
  run: () => void;
  /** The originating action control; focus returns there on dismissal. */
  trigger: HTMLElement;
}

/** The clicked control becomes the focus-return anchor. */
function actionTrigger(event: React.MouseEvent<HTMLButtonElement>): HTMLElement {
  return event.currentTarget;
}

export function AgentGroupsPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [groups, setGroups] = useState<GroupSummaryDto[]>([]);
  const [detail, setDetail] = useState<GroupDetailDto | null>(null);
  // SR-1: the roster arrives as a sibling of the group detail; it is kept
  // separately so render can never see an undefined roster.
  const [detailRoster, setDetailRoster] = useState<GroupRosterEntryDto[]>([]);
  const [newGroup, setNewGroup] = useState("");
  const [addChoice, setAddChoice] = useState("");
  const [fallbackMember, setFallbackMember] = useState("");
  const [fallbackCandidates, setFallbackCandidates] = useState<string[]>([]);
  const [candidateChoice, setCandidateChoice] = useState("");
  const [validation, setValidation] = useState<ValidationState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);

  function handleAuth(cause: unknown): boolean {
    if (cause instanceof UnauthorizedError) {
      onUnauthorized();
      return true;
    }
    return false;
  }

  async function reload(): Promise<void> {
    setPhase({ kind: "loading" });
    try {
      const list = await fetchGroupsList(token);
      if (!list.available || !list.groups) {
        setPhase({ kind: "error", message: list.reason ?? "Agent groups could not be read." });
        return;
      }
      setGroups(list.groups);
      setPhase(list.groups.length === 0 ? { kind: "empty" } : { kind: "ready" });
      if (list.groups.length === 0) {
        setDetail(null);
        setDetailRoster([]);
      }
    } catch (cause) {
      if (!handleAuth(cause)) setPhase({ kind: "error", message: "Agent groups could not be read." });
    }
  }

  async function openGroup(name: string): Promise<void> {
    try {
      const shown = await fetchGroupDetail(name, token);
      if (!shown.available) {
        setNotice(shown.reason ?? "The group could not be read.");
        return;
      }
      setDetail(shown.group);
      setDetailRoster(shown.roster);
      setNotice(null);
      setAddChoice("");
      setCandidateChoice("");
      // SR-2 lead correction: a newly committed group detail resets the WHOLE
      // staged fallback editor, so group A's target/candidates can never be
      // applied to group B and post-mutation re-reads start clean. The
      // member's saved order loads only after an explicit fresh selection.
      setFallbackMember("");
      setFallbackCandidates([]);
    } catch (cause) {
      if (!handleAuth(cause)) setNotice("The group could not be read.");
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Full confirmation-modal discipline: focus moves inside on open,
  // Tab/Shift+Tab cycle within the dialog's actionable controls, and Escape
  // cancels wherever focus is inside. Dismissal returns focus to the
  // originating action (handled by closeConfirm).
  useEffect(() => {
    if (!confirm) return;
    confirmCancelRef.current?.focus();
    const dialog = confirmDialogRef.current;
    if (dialog === null) return;
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea"));
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirm();
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
  }, [confirm]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      if (!handleAuth(cause)) {
        setNotice(`${cause instanceof Error ? cause.message : "The change failed."} The view was refreshed; retry if needed.`);
        await reload().catch(() => {});
        if (detail !== null) await openGroup(detail.name).catch(() => {});
        return;
      }
    } finally {
      setBusy(false);
    }
  }

  function openConfirm(title: string, body: string, runAction: () => void, trigger: HTMLElement): void {
    setConfirm({ title, body, run: runAction, trigger });
  }

  function closeConfirm(): void {
    const trigger = confirm?.trigger ?? null;
    setConfirm(null);
    trigger?.focus();
  }

  function chooseFallbackMember(member: string): void {
    setFallbackMember(member);
    setFallbackCandidates([...(detail?.fallbackOrder[member] ?? [])]);
    setCandidateChoice("");
  }

  function moveFallbackCandidate(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= fallbackCandidates.length) return;
    const next = [...fallbackCandidates];
    const swapped = next[index]!;
    next[index] = next[target]!;
    next[target] = swapped;
    setFallbackCandidates(next);
  }

  function addFallbackCandidate(): void {
    if (candidateChoice === "" || fallbackMember === "") return;
    if (candidateChoice === fallbackMember || fallbackCandidates.includes(candidateChoice)) return;
    setFallbackCandidates([...fallbackCandidates, candidateChoice]);
    setCandidateChoice("");
  }

  function removeFallbackCandidate(index: number): void {
    setFallbackCandidates(fallbackCandidates.filter((_, i) => i !== index));
  }

  function requestFallbackSet(trigger: HTMLElement): void {
    if (detail === null || fallbackMember === "" || busy) return;
    if (fallbackCandidates.includes(fallbackMember) || new Set(fallbackCandidates).size !== fallbackCandidates.length) {
      setNotice("Fallback candidates must be unique members other than the target.");
      return;
    }
    // SR-2 root-cause guard: a candidate picked in the dropdown but never
    // added to the ordered list is NOT part of the save — even when the list
    // already holds other entries. Persisting anyway silently dropped the
    // steward's visible selection; refuse with a bounded reason instead
    // (clearing remains possible once the choice is reset).
    if (candidateChoice !== "") {
      setNotice(`Add ${candidateChoice} to the ordered list first, or set the candidate choice back to “Choose a candidate…”.`);
      return;
    }
    const group = detail;
    const agent = fallbackMember;
    const candidates = [...fallbackCandidates];
    openConfirm(
      `Save fallback order for ${agent} in ${group.name}?`,
      candidates.length === 0
        ? `Saves an EMPTY fallback order for ${agent}; this clears any existing saved candidates for ${agent}.`
        : `Saves the ordered candidate list (${candidates.join(", ")}) exactly as shown.`,
      () =>
        void run(async () => {
          await postGroupAction(
            {
              action: "fallback-set",
              group: group.name,
              agent,
              candidates,
              expectedRevision: group.revision,
              confirm: true,
            },
            token,
          );
          await openGroup(group.name);
          await reload();
        }),
      trigger,
    );
  }

  async function runValidation(): Promise<void> {
    setValidation({ kind: "loading" });
    try {
      const report = await fetchGroupsValidation(token);
      if (!report.available || !report.issues) {
        setValidation({ kind: "idle" });
        setNotice(report.reason ?? "Validation could not be read.");
        return;
      }
      setValidation({ kind: "ready", issues: report.issues });
    } catch (cause) {
      setValidation({ kind: "idle" });
      if (!handleAuth(cause)) setNotice("Validation could not be read.");
    }
  }

  const rosterChoices = detail === null ? [] : detailRoster.filter((entry) => !detail.agents.includes(entry.name));
  const runnableOf = (name: string): boolean | null => {
    if (detail === null) return null;
    const entry = detailRoster.find((r) => r.name === name);
    return entry === undefined ? null : entry.locallyRunnable;
  };
  const candidateChoices =
    fallbackMember === ""
      ? []
      : detail?.agents.filter((a) => a !== fallbackMember && !fallbackCandidates.includes(a)) ?? [];

  return (
    <div className="settings-groups">
      <p className="muted">
        Groups are vault-owned topology under <code>agent-groups/</code>. Members may include agents that are not
        locally runnable; such members are marked but never actionable here.
      </p>
      {phase.kind === "loading" && <p className="muted">Loading…</p>}
      {phase.kind === "error" && (
        <p className="settings-form-error" role="alert">
          {phase.message}
          <button type="button" className="button-link settings-groups-retry" onClick={() => void reload()}><RefreshIcon size={13} />Retry</button>
        </p>
      )}
      {phase.kind === "empty" && <p className="muted">No agent groups yet. Create the first one below.</p>}
      {phase.kind === "ready" && (
        <ul className="settings-groups-list">
          {groups.map((group) => (
            <li key={group.name}>
              <button
                type="button"
                className={detail?.name === group.name ? "settings-group-item settings-group-item-active button-link" : "settings-group-item button-link"}
                onClick={() => void openGroup(group.name)}
              >
                <FolderIcon size={13} />
                {group.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-agent-fallback-add-row">
        <input
          className="settings-groups-new-name"
          type="text"
          aria-label="New group name"
          placeholder="new-group-name"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
        />
        <button
          type="button"
          className="settings-groups-create button-link"
          aria-label="Create group"
          disabled={busy || newGroup.trim() === ""}
          onClick={(event) =>
            openConfirm(
              `Create group ${newGroup.trim()}?`,
              "Creates an empty vault-owned group directory with a skills folder.",
              () =>
                void run(async () => {
                  await postGroupAction({ action: "create", group: newGroup.trim(), expectedRevision: "absent", confirm: true }, token);
                  setNewGroup("");
                  await reload();
                }),
              actionTrigger(event),
            )
          }
        >
          <PlusIcon size={13} />
          Create group
        </button>
        <button type="button" className="settings-groups-validate button-link" disabled={busy} onClick={() => void runValidation()}>
          <ClipboardIcon size={13} />
          Validate all groups
        </button>
      </div>

      {validation.kind === "loading" && <p className="muted">Validating…</p>}
      {validation.kind === "ready" && (
        <div className="settings-groups-validation-report" role="status" aria-label="Cross-group validation report">
          <strong>Cross-group validation</strong>
          {validation.issues.length === 0 ? (
            <p className="muted">OK (no issues).</p>
          ) : (
            <ul>
              {validation.issues.map((issue, i) => (
                <li key={i}>{`[${issue.group}] ${issue.severity === "info" ? "note" : "error"} ${issue.kind}: ${issue.message}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {notice !== null && <p className="settings-form-error" role="alert">{notice}</p>}

      {detail !== null && (
        <section aria-label={`Group ${detail.name}`} className="settings-group-detail">
          <h4>{detail.name}</h4>
          <ul className="settings-agent-fallback-list">
            {detail.agents.map((member) => (
              <li key={member} className="settings-agent-fallback-row">
                <span className="settings-agent-fallback-model">{member}</span>
                {runnableOf(member) === false && (
                  <span className="settings-groups-not-runnable">Not locally runnable</span>
                )}
                <button
                  type="button"
                  className="settings-groups-remove"
                  aria-label={`Remove ${member}`}
                  onClick={(event) =>
                    openConfirm(
                      `Remove ${member} from ${detail.name}?`,
                      "Removes the member and prunes its fallback entries.",
                      () =>
                        void run(async () => {
                          await postGroupAction(
                            { action: "remove-agent", group: detail.name, agent: member, expectedRevision: detail.revision, confirm: true },
                            token,
                          );
                          await openGroup(detail.name);
                          await reload();
                        }),
                      actionTrigger(event),
                    )
                  }
                >
                  <XIcon size={13} />
                </button>
              </li>
            ))}
          </ul>

          <div className="settings-agent-fallback-add-row">
            <select
              className="settings-groups-add-select"
              aria-label={`Add member to ${detail.name}`}
              value={addChoice}
              onChange={(e) => setAddChoice(e.target.value)}
            >
              <option value="">Choose a vault agent…</option>
              {rosterChoices.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}{entry.locallyRunnable ? "" : " (Not locally runnable)"}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="settings-groups-add button-link"
              aria-label={`Add member to ${detail.name}`}
              disabled={busy || addChoice === ""}
              onClick={() =>
                void run(async () => {
                  await postGroupAction({ action: "add-agent", group: detail.name, agent: addChoice, expectedRevision: detail.revision }, token);
                  await openGroup(detail.name);
                  await reload();
                })
              }
            >
              <PlusIcon size={13} />
              Add member
            </button>
          </div>

          <section className="settings-agent-family" aria-label={`Fallback order in ${detail.name}`}>
            <strong>Fallback order per member</strong>
            <p className="muted">Pick a member, build its ordered candidate list, then save. The visible order is the saved order.</p>
            <label className="settings-field">
              Fallback target (member)
              <select
                className="settings-groups-fallback-member"
                value={fallbackMember}
                onChange={(e) => chooseFallbackMember(e.target.value)}
              >
                <option value="">Choose a member…</option>
                {detail.agents.map((member) => (
                  <option key={member} value={member}>{member}</option>
                ))}
              </select>
            </label>
            {fallbackMember === "" ? null : fallbackCandidates.length === 0 ? (
              <p className="muted">No fallback candidates yet.</p>
            ) : (
              <ol className="settings-agent-fallback-list settings-groups-fallback-list">
                {fallbackCandidates.map((candidate, index) => (
                  <li key={`${candidate}-${index}`} className="settings-agent-fallback-row">
                    <span className="settings-agent-fallback-model">{candidate}</span>
                    <button
                      type="button"
                      className="settings-groups-fallback-up"
                      aria-label={`Move ${candidate} up`}
                      disabled={index === 0}
                      onClick={() => moveFallbackCandidate(index, -1)}
                    >
                      <ArrowUpIcon size={13} />
                    </button>
                    <button
                      type="button"
                      className="settings-groups-fallback-down"
                      aria-label={`Move ${candidate} down`}
                      disabled={index === fallbackCandidates.length - 1}
                      onClick={() => moveFallbackCandidate(index, 1)}
                    >
                      <ArrowDownIcon size={13} />
                    </button>
                    <button
                      type="button"
                      className="settings-groups-fallback-remove"
                      aria-label={`Remove ${candidate}`}
                      onClick={() => removeFallbackCandidate(index)}
                    >
                      <XIcon size={13} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {fallbackMember !== "" && (
              <div className="settings-agent-fallback-add-row">
                <select
                  className="settings-groups-fallback-candidate-select"
                  aria-label="Add fallback candidate"
                  value={candidateChoice}
                  onChange={(e) => setCandidateChoice(e.target.value)}
                >
                  <option value="">Choose a candidate…</option>
                  {candidateChoices.map((choice) => (
                    <option key={choice} value={choice}>{choice}</option>
                  ))}
                </select>
                <button type="button" className="settings-groups-fallback-add button-link" aria-label="Add fallback candidate" onClick={addFallbackCandidate}>
                  <PlusIcon size={13} />
                  Add
                </button>
              </div>
            )}
            <button
              type="button"
              className="settings-groups-fallback-save settings-form-save button"
              disabled={busy || fallbackMember === ""}
              onClick={(event) => requestFallbackSet(actionTrigger(event))}
            >
              <SaveIcon size={13} />
              Save fallback
            </button>
          </section>

          {detail.findings.length > 0 && (
            <ul role="status">
              {detail.findings.map((finding, i) => (
                <li key={i}>{`${finding.kind}: ${finding.detail}`}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {confirm !== null && (
        <div className="settings-help-backdrop">
          <div
            ref={confirmDialogRef}
            className="settings-help-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-groups-confirm-title"
          >
            <header className="settings-help-header">
              <h4 id="settings-groups-confirm-title">{confirm.title}</h4>
              <button ref={confirmCancelRef} type="button" className="settings-help-close" aria-label="Close without saving" onClick={closeConfirm}>
                <XIcon size={14} />
              </button>
            </header>
            <p>{confirm.body}</p>
            <p className="muted">Nothing has been written yet.</p>
            <div className="settings-agent-confirm-actions">
              <button type="button" className="settings-agent-confirm-save button" onClick={() => { closeConfirm(); confirm.run(); }}>
                <CheckIcon size={13} />
                Confirm
              </button>
              <button type="button" className="settings-agent-confirm-cancel button" onClick={closeConfirm}>
                <XIcon size={13} />
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
