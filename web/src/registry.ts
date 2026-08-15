/**
 * C3-A: minimal first-party Workbench module registry (W0 §2, folded into
 * C3 by the conversation-first amendment §1). A module is a bounded
 * workspace surface with a declared identity, capability surface, and page.
 * The registry is a compile-time const array — no runtime discovery, no
 * dynamic module loading, no gateway/vault-driven module lookup, no plugin
 * installation. The Conversation surface is the sole module; the old Rooms
 * presentation/source/API is decommissioned (ADR-0043).
 */
import type { Page } from "./nav.js";

export interface WorkbenchModule {
  /** Stable first-party id; the shell nav and the registry agree on it. */
  id: string;
  /** Human label for navigation. */
  label: string;
  /** Position in the shell sidebar. */
  navOrder: number;
  /** The nav page this module renders. */
  page: Page;
  /** Declared gateway endpoint families this module consumes. */
  consumes: readonly string[];
  /** Declared cross-module intents this module may emit (none today). */
  emits: readonly string[];
}

/** The compiled-in first-party module set (exactly the Conversation module). */
export const WORKBENCH_MODULES: readonly WorkbenchModule[] = [
  {
    id: "conversations",
    label: "Conversations",
    navOrder: 0,
    page: "conversations",
    consumes: ["conversations", "conversation-agents"],
    emits: [],
  },
];

/** Lookup a module by its stable first-party id. */
export function getModuleById(id: string): WorkbenchModule | undefined {
  return WORKBENCH_MODULES.find((module) => module.id === id);
}

/** Resolve the Conversation module; Dashboard is a shell entry surface, not a module. */
export function moduleForPage(page: Page): WorkbenchModule | undefined {
  return WORKBENCH_MODULES.find((module) => module.page === page);
}
