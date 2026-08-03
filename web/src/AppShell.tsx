import { useRef, useState } from "react";
import logoUrl from "./assets/piren-logo.png";
import { closeDrawer, initialNavState, selectPage, toggleDrawer, type Page } from "./nav";
import { StatusBadge, type ShellPhase } from "./StatusBadge";
import { Sidebar } from "./Sidebar";
import { MobileDrawer } from "./MobileDrawer";
import { RoomNavigator } from "./RoomNavigator";
import { AgentsView } from "./AgentsView";
import { AboutView } from "./AboutView";

const COMING_NEXT = [
  { label: "Room timeline", bullet: "R3b-3", note: "historic events plus live SSE, immutable rendering, reconnect re-read" },
  { label: "Structured dispatch", bullet: "R3b-4", note: "the video-ready \u201cPiren building itself\u201d demonstration" },
  { label: "Approval + abort controls", bullet: "R3b-5", note: "scoped approval cards and room-agent abort" },
  { label: "Accessibility completion", bullet: "R3b-6", note: "focused WCAG 2.2 AA verification" },
] as const;

/**
 * Workbench app shell (ADR-0041 R3b-2.5): persistent desktop sidebar
 * (Rooms → Agents roster → About), responsive mobile burger drawer, and a
 * main workspace. RoomNavigator stays MOUNTED across view switches (hidden
 * toggling) so a view change never cancels a room run and never creates
 * client-side delivery/approval/retry truth.
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

  function handleSelect(page: Page) {
    setNav((previous) => selectPage(previous, page));
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
          <p className="shell-subtitle">Local-first agent collaboration shell</p>
        </div>
        <button
          type="button"
          ref={toggleRef}
          className="nav-toggle button"
          aria-expanded={nav.drawerOpen}
          aria-controls="mobile-drawer"
          onClick={handleToggleDrawer}
        >
          Menu
        </button>
        <StatusBadge phase={phase} />
      </header>

      <div className="shell-body">
        <div className="sidebar-desktop">
          <Sidebar page={nav.page} onSelect={handleSelect} />
        </div>

        <MobileDrawer open={nav.drawerOpen} onClose={handleCloseDrawer} label="Navigation">
          <Sidebar page={nav.page} onSelect={handleSelect} />
        </MobileDrawer>

        <main className="shell-main">
          {phase === "ready-local" && (
            <section className="card">
              <p className="muted">Gateway reachable — this host requires no token.</p>
            </section>
          )}
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
          <div className="workspace-panel" hidden={nav.page !== "rooms"}>
            <RoomNavigator token={token} onValidated={onValidated} onUnauthorized={onUnauthorized} />
            <ComingNext />
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

function ComingNext() {
  return (
    <section className="card">
      <h3>Coming next (each separately steward-gated)</h3>
      <ul className="coming-next">
        {COMING_NEXT.map((item) => (
          <li key={item.bullet}>
            <span className="coming-label">
              {item.label} <code>{item.bullet}</code>
            </span>
            <span className="coming-note">{item.note}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        Read-only vault/graph navigation is deferred to R4; the service worker is deferred to R3c
        or later.
      </p>
    </section>
  );
}
