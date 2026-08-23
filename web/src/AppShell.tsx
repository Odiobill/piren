import { useCallback, useRef, useState } from "react";
import logoUrl from "./assets/piren-logo.png";
import { closeDrawer, initialNavState, selectPage, shouldRestoreFocusAfterSelect, toggleDrawer, type Page } from "./nav";
import { StatusBadge, type ShellPhase } from "./StatusBadge";
import { Sidebar } from "./Sidebar";
import { MobileDrawer } from "./MobileDrawer";
import { ConversationNavigator } from "./ConversationNavigator";
import { DashboardView } from "./DashboardView";
import { SplitWorkspaceShell } from "./SplitWorkspaceShell";
import { initialSplitWorkspaceState, mobileSelectPane, type SplitWorkspaceState } from "./split-workspace";
import { getModuleById } from "./registry";
import { VaultExplorer } from "./VaultExplorer";
import { SettingsView } from "./SettingsView";
import { formatConversationHash } from "./hash-route";

/**
 * Workbench app shell (ADR-0041 R3b-2.5; C3-A; ADR-0044): persistent desktop
 * sidebar (Dashboard nav + conversation switcher), responsive mobile burger
 * drawer, and a main workspace. The Dashboard is the default surface.
 * ConversationNavigator stays MOUNTED across view switches (hidden toggling)
 * so a view change never cancels a conversation run and never creates
 * client-side delivery/approval/retry truth. The retired Agents/About pages
 * are gone (ADR-0044).
 */
export function AppShell({
  phase,
  token,
  onValidated,
  onUnauthorized,
}: {
  phase: ShellPhase;
  token: string;
  onValidated: () => void;
  onUnauthorized: () => void;
}) {
  const [nav, setNav] = useState(initialNavState());
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** U1/U2/ADR-0044: bump when a conversation is created or renamed so the sidebar and Dashboard refresh. */
  const [conversationsReloadKey, setConversationsReloadKey] = useState(0);
  /**
   * P2: the shell subtitle is contextual while a Conversation is selected
   * (active or read-only); no selection keeps the calm generic subtitle. Set
   * from the navigator's re-gated gateway-authoritative manifest only.
   */
  const [contextualTitle, setContextualTitle] = useState<string | null>(null);
  /**
   * ADR-0044 Tracer B: true only while the selected Conversation is ACTIVE.
   * The active surface clips the shell to the viewport so the named history
   * region is the sole Conversation scroll host; read-only/no-selection keep
   * the R1 document-flow layout.
   */
  const [conversationActive, setConversationActive] = useState(false);
  const handleConversationsChanged = useCallback(() => setConversationsReloadKey((key) => key + 1), []);
  // Stable identity: the navigator's selection effect depends on this callback.
  const handleSelectionChange = useCallback((title: string | null, active: boolean) => {
    setContextualTitle(title);
    setConversationActive(active);
  }, []);
  /**
   * W1 (0.2.0 amendment §3): shell-level companion split state — in-memory
   * only, closed by default. No companion module is registered in W1 (W2 is
   * separately gated), so the split shell is an inert pass-through today; it
   * is ready to receive a future companion without any user-visible change.
   */
  const [splitState, setSplitState] = useState<SplitWorkspaceState>(initialSplitWorkspaceState);
  /**
   * W1: the smallest existing re-anchor signal — bumped on every resizer
   * commit so the anchored reader re-anchors after a pure pane resize
   * (anchor core unchanged). Never bumped while the split is closed.
   */
  const [reAnchorKey, setReAnchorKey] = useState(0);
  const handleSplitReAnchor = useCallback(() => setReAnchorKey((key) => key + 1), []);
  /**
   * W2 (0.2.0 amendment §4): the first companion module open/close state —
   * in-memory only. The single explicit affordance is the sidebar toggle;
   * opening never steals chat focus, closing returns focus to the opener.
   */
  const [explorerOpen, setExplorerOpen] = useState(false);
  const explorerButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * W2: the smallest existing typed selection signal at the shell boundary.
   * The navigator reports the gateway-authoritative title (or null) via
   * onSelectionChange; null means no selected Conversation -> the open
   * Explorer falls back to a full-page module surface (no split/resizer).
   */
  const hasSelectedConversation = contextualTitle !== null;
  // WUX-A: the open Explorer with NO selected Conversation is a full-page
  // module surface; it is then the sole highlighted sidebar module.
  const explorerFullPage = explorerOpen && !hasSelectedConversation;
  const vaultExplorerLabel = getModuleById("vault-explorer")?.label ?? "Vault Explorer";

  function handleToggleExplorer() {
    if (explorerOpen) {
      // Close: restore the normal view and return focus to the opener.
      setExplorerOpen(false);
      setNav((previous) => closeDrawer(previous));
      const target = nav.drawerOpen ? toggleRef.current : explorerButtonRef.current ?? toggleRef.current;
      target?.focus();
      return;
    }
    // Open: no focus theft (the clicked toggle keeps focus). On mobile/
    // portrait the Explorer pane is selected first; the labelled toggle
    // still retains the chat mounted/live underneath.
    setExplorerOpen(true);
    setSplitState((previous) => mobileSelectPane(previous, "companion"));
    // A selected Conversation opens the companion beside that Conversation,
    // even when its still-mounted workspace was previously hidden by Dashboard.
    setNav((previous) =>
      hasSelectedConversation ? selectPage(closeDrawer(previous), "conversations") : closeDrawer(previous),
    );
    // A drawer action unmounts with the drawer; return focus to its persistent
    // menu opener instead of leaving focus on a removed button.
    if (nav.drawerOpen) toggleRef.current?.focus();
  }

  /**
   * V1 — the explicit full-page Explorer action. Ensures the Explorer is
   * open; with a selected Conversation it writes the EXISTING no-selection
   * hash route (an empty hash) so the still-mounted navigator's ordinary
   * hashchange re-gate produces the no-selection signal that yields the
   * full-page fallback — the browser never fabricates selection/title state.
   * With no selection there is no hash write at all. It never aborts,
   * closes, archives, detaches, or otherwise mutates Conversation lifecycle,
   * session, or broker state. A drawer action closes the drawer and returns
   * focus to the persistent Menu control; the desktop action does not steal
   * focus.
   */
  function handleOpenExplorerFullPage() {
    setExplorerOpen(true);
    setSplitState((previous) => mobileSelectPane(previous, "companion"));
    if (hasSelectedConversation && window.location.hash !== "") {
      window.location.hash = "";
    }
    if (nav.drawerOpen) {
      setNav((previous) => closeDrawer(previous));
      toggleRef.current?.focus();
    }
  }

  function handleSelect(page: Page) {
    // A normal page selection leaves the companion workspace context, so a
    // no-selection full-page Explorer cannot obscure Dashboard or Settings.
    // Selecting Conversations intentionally preserves it: a fresh selection
    // may turn the Explorer into the W1 split.
    if (page !== "conversations") setExplorerOpen(false);
    // A selection made from the open mobile drawer closes it and must return
    // focus to the menu toggle; desktop sidebar selections never move focus.
    const restoreFocus = shouldRestoreFocusAfterSelect(nav);
    setNav((previous) => selectPage(previous, page));
    if (restoreFocus) toggleRef.current?.focus();
  }

  /**
   * ADR-0044: open one conversation through the existing authoritative
   * route/attach flow — select the conversations page and write the durable
   * hash route; the navigator's fresh manifest + attach gate decides the
   * active/read-only presentation. The sidebar/Dashboard lists refresh from
   * the existing conversation read.
   */
  function handleOpenConversation(id: string) {
    handleSelect("conversations");
    handleConversationsChanged();
    window.location.hash = formatConversationHash(id);
  }

  function handleToggleDrawer() {
    setNav((previous) => toggleDrawer(previous));
  }

  function handleCloseDrawer() {
    setNav((previous) => closeDrawer(previous));
    toggleRef.current?.focus();
  }

  return (
    <div
      className={`shell${nav.page === "conversations" ? " shell-conversation" : ""}${
        conversationActive && nav.page === "conversations" ? " shell-conversation-active" : ""
      }`}
    >
      <header className="shell-header">
        <img src={logoUrl} alt="Piren logo" className="shell-logo" width={48} height={48} />
        <div className="shell-heading">
          <h1>Piren Workbench</h1>
          <p className="shell-subtitle">{contextualTitle ?? "A calm workspace for your local-first agent team"}</p>
        </div>
        <button
          type="button"
          ref={toggleRef}
          className="nav-toggle button"
          aria-expanded={nav.drawerOpen}
          aria-controls="mobile-drawer"
          onClick={handleToggleDrawer}
        >
          <span className="hamburger" aria-hidden="true">
            <span className="hamburger-line" />
            <span className="hamburger-line" />
            <span className="hamburger-line" />
          </span>
          <span className="sr-only">Menu</span>
        </button>
        {phase !== "ready-local" && <StatusBadge phase={phase} />}
      </header>

      <div className="shell-body">
        <div className="sidebar-desktop">
          <Sidebar
            page={nav.page}
            token={token}
            onSelect={handleSelect}
            onValidated={onValidated}
            onUnauthorized={onUnauthorized}
            conversationsReloadKey={conversationsReloadKey}
            explorerOpen={explorerOpen}
            onToggleExplorer={handleToggleExplorer}
            explorerToggleRef={explorerButtonRef}
            onOpenExplorerFullPage={handleOpenExplorerFullPage}
            explorerFullPage={explorerFullPage}
          />
        </div>

        <MobileDrawer open={nav.drawerOpen} onClose={handleCloseDrawer} label="Navigation">
          <Sidebar
            page={nav.page}
            token={token}
            onSelect={handleSelect}
            onValidated={onValidated}
            onUnauthorized={onUnauthorized}
            conversationsReloadKey={conversationsReloadKey}
            explorerOpen={explorerOpen}
            onToggleExplorer={handleToggleExplorer}
            onOpenExplorerFullPage={handleOpenExplorerFullPage}
            explorerFullPage={explorerFullPage}
          />
        </MobileDrawer>

        <main className="shell-main">
          {phase === "token-ready" && (
            <section className="card">
              <p className="muted">
                Token ready, held in memory for this page only and <strong>not validated</strong>: your
                first protected request below checks it. A rejected token returns you to the token
                entry without persisting anything.
              </p>
            </section>
          )}
          {phase === "token-accepted" && (
            <section className="card">
              <p className="muted">
                Token accepted: the gateway accepted it on a protected request. It stays in memory only.
              </p>
            </section>
          )}
          {/* W2: with NO selected Conversation the open Explorer is a
              full-page module surface (no split/resizer); the Conversation UI
              stays mounted/unchanged behind the view. */}
          {explorerOpen && !hasSelectedConversation && (
            <div className="workspace-panel vault-explorer-fullpage">
              <VaultExplorer token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
            </div>
          )}
          <div
            className="workspace-panel workspace-panel-conversations"
            hidden={nav.page !== "conversations" || (explorerOpen && !hasSelectedConversation)}
          >
            <SplitWorkspaceShell
              state={{ ...splitState, open: explorerOpen && hasSelectedConversation }}
              onStateChange={setSplitState}
              chat={
                <ConversationNavigator
                  token={token}
                  onValidated={onValidated}
                  onUnauthorized={onUnauthorized}
                  onConversationsChanged={handleConversationsChanged}
                  onSelectionChange={handleSelectionChange}
                  reAnchorKey={reAnchorKey}
                />
              }
              companion={explorerOpen ? <VaultExplorer token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} /> : undefined}
              resizerLabel="Resize chat pane"
              chatLabel="Chat"
              companionLabel={vaultExplorerLabel}
              onReAnchor={handleSplitReAnchor}
            />
          </div>
          <div className="workspace-panel" hidden={nav.page !== "dashboard" || (explorerOpen && !hasSelectedConversation)}>
            <DashboardView
              token={token}
              onValidated={onValidated}
              onUnauthorized={onUnauthorized}
              onOpenConversation={handleOpenConversation}
              onRefreshConversations={handleConversationsChanged}
              reloadKey={conversationsReloadKey}
            />
          </div>
          {/* W3: the static full-page Settings shell — a plain typed nav
              page. Read-only inventory only; no fetch, no state, no controls.
              Hidden-toggling preserves the mounted Conversation surface. */}
          <div className="workspace-panel" hidden={nav.page !== "settings" || (explorerOpen && !hasSelectedConversation)}>
            <SettingsView token={token} onUnauthorized={onUnauthorized} onValidated={onValidated} />
          </div>
        </main>
      </div>
    </div>
  );
}
