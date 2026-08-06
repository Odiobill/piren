import type { Page } from "./nav";

const NAV_ITEMS: ReadonlyArray<{ page: Page; label: string }> = [
  { page: "conversations", label: "Conversations" },
  { page: "agents", label: "Agents" },
  { page: "about", label: "About" },
];

/**
 * Main navigation for the workbench app shell (ADR-0041 R3b-2.5; C3-A):
 * Conversations (the unified chat surface over the C2 API), the local-policy
 * agent roster page, and the read-only About page. Rendered in the desktop
 * sidebar and inside the mobile drawer.
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
