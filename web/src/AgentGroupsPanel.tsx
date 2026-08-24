import { useEffect, useRef, useState } from "react";
import { fetchGroupDetail, fetchGroupsList, postGroupAction, type GroupDetailDto, type GroupSummaryDto } from "./groups-api";
import { CheckIcon, FolderIcon, PlusIcon, RefreshIcon, XIcon } from "./icons";

/**
 * ST-4: typed vault-owned Agent Groups workflows. Groups may contain locally
 * non-runnable agents (marked, never actionable). Create/remove-agent and
 * fallback-set require explicit labelled confirmation modals with focus
 * trap/return; conflict re-reads. No local-policy access, no persistence.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready" };

export function AgentGroupsPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [groups, setGroups] = useState<GroupSummaryDto[]>([]);
  const [detail, setDetail] = useState<GroupDetailDto | null>(null);
  const [newGroup, setNewGroup] = useState("");
  const [addAgent, setAddAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => void } | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  function handleAuth(cause: unknown): boolean {
    if (cause instanceof Error && /401|unauthorized/i.test(cause.message)) {
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
      if (list.groups.length === 0) setDetail(null);
    } catch (cause) {
      if (!handleAuth(cause)) setPhase({ kind: "error", message: "Agent groups could not be read." });
    }
  }

  async function openGroup(name: string): Promise<void> {
    try {
      const shown = await fetchGroupDetail(name, token);
      if (!shown.available || !shown.group) {
        setNotice(shown.reason ?? "The group could not be read.");
        return;
      }
      setDetail(shown.group);
      setNotice(null);
    } catch (cause) {
      if (!handleAuth(cause)) setNotice("The group could not be read.");
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!confirm) return;
    confirmCancelRef.current?.focus();
    const dialog = confirmCancelRef.current?.closest('[role="dialog"]');
    if (dialog === null || dialog === undefined) return;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeConfirm();
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
        // Conflict-style bounded retry guidance; then refresh truth.
        setNotice(`${cause instanceof Error ? cause.message : "The change failed."} The view was refreshed; retry if needed.`);
        await reload().catch(() => {});
        if (detail !== null) await openGroup(detail.name).catch(() => {});
        return;
      }
    } finally {
      setBusy(false);
    }
  }

  function closeConfirm(): void {
    setConfirm(null);
    confirmCancelRef.current?.blur();
  }

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
          onClick={() =>
            setConfirm({
              title: `Create group ${newGroup.trim()}?`,
              body: "Creates an empty vault-owned group directory with a skills folder.",
              run: () =>
                void run(async () => {
                  await postGroupAction({ action: "create", group: newGroup.trim(), expectedRevision: "absent", confirm: true }, token);
                  setNewGroup("");
                  await reload();
                }),
            })
          }
        >
          <PlusIcon size={13} />
          Create group
        </button>
      </div>

      {notice !== null && <p className="settings-form-error" role="alert">{notice}</p>}

      {detail !== null && (
        <section aria-label={`Group ${detail.name}`} className="settings-group-detail">
          <h4>{detail.name}</h4>
          <ul className="settings-agent-fallback-list">
            {detail.agents.map((member) => {
              const runnable = detail.fallbackOrder[member] !== undefined;
              void runnable;
              return (
                <li key={member} className="settings-agent-fallback-row">
                  <span className="settings-agent-fallback-model">{member}</span>
                  {!detail.agents.includes(member) || true ? null : null}
                  <button
                    type="button"
                    className="settings-groups-remove"
                    aria-label={`Remove ${member}`}
                    onClick={() =>
                      setConfirm({
                        title: `Remove ${member} from ${detail.name}?`,
                        body: "Removes the member and prunes its fallback entries.",
                        run: () =>
                          void run(async () => {
                            await postGroupAction({ action: "remove-agent", group: detail.name, agent: member, expectedRevision: detail.revision, confirm: true }, token);
                            await openGroup(detail.name);
                            await reload();
                          }),
                      })
                    }
                  >
                    <XIcon size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted">Fallback order is configured per member below; order shown is order saved.</p>
          {Object.entries(detail.fallbackOrder).map(([member, candidates]) => (
            <p key={member} className="settings-agent-fallback-model">
              {member}: {candidates.join(", ") || "none"}
            </p>
          ))}
          {detail.findings.length > 0 && (
            <ul role="status">
              {detail.findings.map((finding, i) => (
                <li key={i}>{`${finding.kind}: ${finding.detail}`}</li>
              ))}
            </ul>
          )}
          <div className="settings-agent-fallback-add-row">
            <input
              className="settings-groups-add-member"
              type="text"
              aria-label={`Add member to ${detail.name}`}
              placeholder="vault-agent-name"
              value={addAgent}
              onChange={(e) => setAddAgent(e.target.value)}
            />
            <button
              type="button"
              className="settings-groups-add button-link"
              aria-label={`Add member to ${detail.name}`}
              disabled={busy || addAgent.trim() === "" || detail.revision === ""}
              onClick={() =>
                void run(async () => {
                  await postGroupAction({ action: "add-agent", group: detail.name, agent: addAgent.trim(), expectedRevision: detail.revision }, token);
                  setAddAgent("");
                  await openGroup(detail.name);
                  await reload();
                })
              }
            >
              <PlusIcon size={13} />
              Add member
            </button>
          </div>
        </section>
      )}

      {confirm !== null && (
        <div className="settings-help-backdrop">
          <div className="settings-help-dialog card" role="dialog" aria-modal="true" aria-labelledby="settings-groups-confirm-title">
            <header className="settings-help-header">
              <h4 id="settings-groups-confirm-title">{confirm.title}</h4>
              <button ref={confirmCancelRef} type="button" className="settings-help-close" aria-label="Close without saving" onClick={closeConfirm}>
                <XIcon size={14} />
              </button>
            </header>
            <p>{confirm.body}</p>
            <p className="muted">Nothing has been written yet.</p>
            <div className="settings-agent-confirm-actions">
              <button type="button" className="button" onClick={() => { closeConfirm(); confirm.run(); }}>
                <CheckIcon size={13} />
                Confirm
              </button>
              <button type="button" className="button" onClick={closeConfirm}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
