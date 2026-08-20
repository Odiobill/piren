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

/**
 * W1 (0.2.0 amendment §3; accepted companion split architecture §1): where a
 * module renders in the shell. `page` — today's model, the module owns the
 * full workspace when its page is selected (unchanged). `companion` — usable
 * alongside the active chat in the split workspace. The registry stays a
 * compile-time const; no runtime discovery, no dynamic imports, no plugin
 * installation. No companion module is registered yet (W2 is separately
 * gated); the flag is declarative so any future module can opt in.
 */
export type ModulePlacement = "page" | "companion";

export interface WorkbenchModule {
  /** Stable first-party id; the shell nav and the registry agree on it. */
  id: string;
  /** Human label for navigation. */
  label: string;
  /** Position in the shell sidebar. */
  navOrder: number;
  /** The nav page this module renders. */
  page: Page;
  /** Where the module renders: full page or companion split (W1). */
  placement: ModulePlacement;
  /** Declared gateway endpoint families this module consumes. */
  consumes: readonly string[];
  /** Declared cross-module intents this module may emit (none today). */
  emits: readonly string[];
}

/** The compiled-in first-party module set (the Conversation page + the W2 companion). */
export const WORKBENCH_MODULES: readonly WorkbenchModule[] = [
  {
    id: "conversations",
    label: "Conversations",
    navOrder: 0,
    page: "conversations",
    placement: "page",
    consumes: ["conversations", "conversation-agents"],
    emits: [],
  },
  {
    id: "vault-explorer",
    label: "Vault Explorer",
    navOrder: 1,
    page: "conversations",
    placement: "companion",
    // W2: consumes ONLY the existing bounded read-only vault list/read
    // families; graph presentation is deferred and never consumed here.
    consumes: ["vault-list", "vault-read"],
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
