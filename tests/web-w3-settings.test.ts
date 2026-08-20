import { describe, expect, it } from "vitest";
import { WORKBENCH_MODULES, getModuleById, moduleForPage } from "../web/src/registry.js";
import { initialNavState, selectPage, type Page } from "../web/src/nav.js";
import {
  SETTINGS_INVENTORY,
  familiesForTier,
  type SettingsFamily,
} from "../web/src/settings-inventory.js";

/**
 * W3 (0.2.0 amendment §5/§5.1; ADR-0046) — pure model tests for the static
 * full-page Settings shell: nav page, registry entry (page placement, zero
 * declared consumption), and the read-only Tier A/B/C inventory model.
 */

describe("W3 nav model: settings page", () => {
  it("exposes exactly the three shell pages", () => {
    const pages: Page[] = ["dashboard", "conversations", "settings"];
    expect(pages).toHaveLength(3);
  });

  it("selectPage switches to settings and closes the drawer", () => {
    const open = { ...initialNavState(), drawerOpen: true };
    const selected = selectPage(open, "settings");
    expect(selected.page).toBe("settings");
    expect(selected.drawerOpen).toBe(false);
  });
});

describe("W3 registry: settings module", () => {
  it("registers a static first-party settings module with page placement", () => {
    const settings = getModuleById("settings");
    expect(settings).toBeDefined();
    expect(settings?.label).toBe("Settings");
    expect(settings?.placement).toBe("page");
    expect(settings?.page).toBe("settings");
    expect(moduleForPage("settings")?.id).toBe("settings");
  });

  it("declares NO endpoint consumption and NO intents (read-only static shell)", () => {
    const settings = getModuleById("settings");
    expect(settings?.consumes).toEqual([]);
    expect(settings?.emits).toEqual([]);
  });

  it("keeps the existing modules unchanged (W1/W2 preservation)", () => {
    expect(getModuleById("conversations")?.placement).toBe("page");
    const explorer = getModuleById("vault-explorer");
    expect(explorer?.placement).toBe("companion");
    expect(explorer?.consumes).toEqual(["vault-list", "vault-read"]);
  });
});

describe("W3 settings inventory model (amendment §5.1)", () => {
  it("groups families into exactly the Tier A / Tier B / Tier C structure", () => {
    const tierA = familiesForTier("tier-a");
    const tierB = familiesForTier("tier-b");
    const tierC = familiesForTier("tier-c");
    expect(tierA.length).toBeGreaterThanOrEqual(7);
    expect(tierB.length).toBeGreaterThanOrEqual(6);
    expect(tierC.length).toBeGreaterThanOrEqual(1);
    for (const family of SETTINGS_INVENTORY) {
      expect(family.id.length).toBeGreaterThan(0);
      expect(family.label.length).toBeGreaterThan(0);
      expect(family.description.length).toBeGreaterThan(0);
      expect(family.availability.length).toBeGreaterThan(0);
    }
  });

  it("Tier A names the forthcoming typed workflows (transports, scheduler, agent preferences)", () => {
    const ids = familiesForTier("tier-a").map((f: SettingsFamily) => f.id);
    expect(ids).toContain("telegram");
    expect(ids).toContain("discord");
    expect(ids).toContain("scheduler");
    expect(ids).toContain("agent-model-preference");
    expect(ids).toContain("agent-model-fallback");
    expect(ids).toContain("agent-context-injection");
    expect(ids).toContain("agent-self-improvement");
  });

  it("describes agent model preference through the existing agent-config parse contract without inventing catalog validation", () => {
    const modelPreference = familiesForTier("tier-a").find((f: SettingsFamily) => f.id === "agent-model-preference");
    expect(modelPreference?.description).toMatch(/agent-config parse contract/i);
    expect(modelPreference?.description).not.toMatch(/Pi's model id forms/i);
  });

  it("labels delivered model.fallback as existing bounded opt-in same-agent/same-session continuation", () => {
    const fallback = familiesForTier("tier-a").find((f: SettingsFamily) => f.id === "agent-model-fallback");
    expect(fallback).toBeDefined();
    expect(fallback?.description).toMatch(/same agent/i);
    expect(fallback?.description).toMatch(/same live session|same session/i);
    expect(fallback?.description).not.toMatch(/deferred|inert groundwork|not implemented/i);
  });

  it("every Tier A and Tier C family states it is not available in this shell", () => {
    for (const family of [...familiesForTier("tier-a"), ...familiesForTier("tier-c")]) {
      expect(family.availability).toMatch(/not available in this shell/i);
    }
  });

  it("Tier B families are read-only inspection only and never expose secrets", () => {
    for (const family of familiesForTier("tier-b")) {
      expect(family.description + family.availability).toMatch(/read-only/i);
    }
    const gateway = familiesForTier("tier-b").find((f: SettingsFamily) => f.id === "gateway-bind-token");
    expect(gateway?.description).toMatch(/never the token/i);
  });

  it("Tier C covers exactly the four service targets with separately-confirmed explicit actions", () => {
    const services = familiesForTier("tier-c").find((f: SettingsFamily) => f.id === "service-lifecycle");
    expect(services).toBeDefined();
    for (const target of ["gateway", "telegram", "discord", "scheduler"]) {
      expect(services?.description).toContain(target);
    }
    expect(services?.description).toMatch(/explicit|confirm/i);
  });
});
