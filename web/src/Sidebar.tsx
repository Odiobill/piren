import type { Page } from "./nav";

const NAV_ITEMS: ReadonlyArray<{ page: Page; label: string }> = [
  { page: "rooms", label: "Rooms" },
  { page: "agents", label: "Agents" },
  { page: "about", label: "About" },
];

/**
 * Main navigation for the workbench app shell (ADR-0041 R3b-2.5): Rooms,
 * the local-policy agent roster page, and the read-only About page. Rendered
 * in the desktop sidebar and inside the mobile drawer. Direct-chat entries
 * are not navigation targets here — the Agents page is read-only until
 * direct chat is separately authorized.
 */
export function Sidebar({ page, onSelect }: { page: Page; onSelect: (page: Page) => void }) {
  return (
    <nav className="sidebar-nav" aria-label="Main">
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.page}>
            <button
              type="button"
              className={page === item.page ? "nav-item active" : "nav-item"}
              aria-current={page === item.page ? "page" : undefined}
              onClick={() => onSelect(item.page)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
