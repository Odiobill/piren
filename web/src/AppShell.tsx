import { useCallback, useRef, useState } from "react";
import logoUrl from "./assets/piren-logo.png";
import { closeDrawer, initialNavState, selectPage, shouldRestoreFocusAfterSelect, toggleDrawer, type Page } from "./nav";
import { StatusBadge, type ShellPhase } from "./StatusBadge";
import { Sidebar } from "./Sidebar";
import { MobileDrawer } from "./MobileDrawer";
import { ConversationNavigator } from "./ConversationNavigator";
import { AgentsView } from "./AgentsView";
import { AboutView } from "./AboutView";

/**
 * Workbench app shell (ADR-0041 R3b-2.5; C3-A replaces the Rooms page with
 * the Conversation surface): persistent desktop sidebar (Conversations →
 * Agents roster → About), responsive mobile burger drawer, and a main
 * workspace. ConversationNavigator stays MOUNTED across view switches
 * (hidden toggling) so a view change never cancels a conversation run and
 * never creates client-side delivery/approval/retry truth.
 */
export function AppShell({
  phase,
  token,
  authRequired,
  onValidated,
  onUnauthorized,
}: {
  phase: ShellPhase;
  token: string;
  authRequired: boolean;
  onValidated: () => void;
  onUnauthorized: () => void;
}) {
  const [nav, setNav] = useState(initialNavState());
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** U1/U2: bump when a conversation is created or renamed so the sidebar refreshes. */
  const [conversationsReloadKey, setConversationsReloadKey] = useState(0);
  /**
   * P2: the shell subtitle is contextual while a Conversation is selected
   * (active or read-only); the draft keeps the calm generic subtitle. Set
   * from the navigator's re-gated gateway-authoritative manifest only.
   */
  const [contextualTitle, setContextualTitle] = useState<string | null>(null);
  const handleConversationsChanged = useCallback(() => setConversationsReloadKey((key) => key + 1), []);

  function handleSelect(page: Page) {
    // A selection made from the open mobile drawer closes it and must return
    // focus to the menu toggle; desktop sidebar selections never move focus.
    const restoreFocus = shouldRestoreFocusAfterSelect(nav);
    setNav((previous) => selectPage(previous, page));
    if (restoreFocus) toggleRef.current?.focus();
  }

  function handleToggleDrawer() {
    setNav((previous) => toggleDrawer(previous));
  }

  function handleCloseDrawer() {
    setNav((previous) => closeDrawer(previous));
    toggleRef.current?.focus();
  }

  return (
    <div className="shell">
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
          />
        </MobileDrawer>

        <main className="shell-main">
          {phase === "token-ready" && (
            <section className="card">
              <p className="muted">
                Token ready — held in memory for this page only and has <strong>not been validated</strong>: your
                first protected request below checks it. A rejected token returns you to the token
                entry without persisting anything.
              </p>
            </section>
          )}
          {phase === "token-accepted" && (
            <section className="card">
              <p className="muted">
                Token accepted — the gateway accepted it on a protected request. It stays in memory
                only.
              </p>
            </section>
          )}
          <div className="workspace-panel workspace-panel-conversations" hidden={nav.page !== "conversations"}>
            <ConversationNavigator
              token={token}
              onValidated={onValidated}
              onUnauthorized={onUnauthorized}
              onConversationsChanged={handleConversationsChanged}
              onSelectionChange={setContextualTitle}
            />
          </div>
          <div className="workspace-panel" hidden={nav.page !== "agents"}>
            <AgentsView token={token} onUnauthorized={onUnauthorized} />
          </div>
          <div className="workspace-panel" hidden={nav.page !== "about"}>
            <AboutView phase={phase} authRequired={authRequired} />
          </div>
        </main>
      </div>

      <footer className="shell-footer">
        <p>
          Piren — the browser is an untrusted UI client; Pi owns live sessions and the vault owns
          durable knowledge.
        </p>
      </footer>
    </div>
  );
}
