/**
 * Pure nav-state model for the workbench app shell (ADR-0041 R3b-2.5;
 * C3-A replaces the Rooms page with the Conversation surface).
 * Framework-free so shell transitions are directly unit-testable. The drawer
 * is a mobile/portrait overlay; selecting a page always closes it.
 */
export type Page = "conversations" | "agents" | "about";

export interface NavState {
  page: Page;
  drawerOpen: boolean;
}

export function initialNavState(): NavState {
  return { page: "conversations", drawerOpen: false };
}

/** Select a page; the drawer always closes (mobile behavior). */
export function selectPage(state: NavState, page: Page): NavState {
  if (state.page === page && !state.drawerOpen) return state;
  return { page, drawerOpen: false };
}

export function toggleDrawer(state: NavState): NavState {
  return { ...state, drawerOpen: !state.drawerOpen };
}

export function closeDrawer(state: NavState): NavState {
  return state.drawerOpen ? { ...state, drawerOpen: false } : state;
}

/**
 * After a navigation selection, focus must return to the menu toggle iff the
 * drawer was open (the selection closes it). Desktop sidebar selections
 * never open the drawer, so they must not move focus.
 */
export function shouldRestoreFocusAfterSelect(state: NavState): boolean {
  return state.drawerOpen;
}
