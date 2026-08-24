// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GatewayServer } from "../src/gateway-http.js";
import { AgentGroupsPanel } from "../web/src/AgentGroupsPanel.js";

/**
 * SR-2 regression — FULL closed path for the reported production defect:
 * persisted agent-groups fallback_order entries saved empty.
 *
 * Unlike tests/web-st-4-groups-panel.test.ts (which mocks postGroupAction),
 * this drives the REAL panel against a REAL gateway over real HTTP with a
 * real temp vault: create group -> add two vault members -> select target ->
 * add candidate -> explicit confirmation -> POST -> persisted YAML re-read,
 * plus the reloaded UI state.
 */

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

let vault: string;
let base = "";
const realFetch = globalThis.fetch.bind(globalThis);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "piren-sr2-"));
  mkdirSync(join(vault, "team", "Piren"), { recursive: true });
  mkdirSync(join(vault, "team", "Vera"), { recursive: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function configPath(): string {
  return join(vault, "agent-groups", "test", "config.yml");
}

async function startServer(): Promise<GatewayServer> {
  const server = new GatewayServer({
    target: { command: process.execPath, args: [fakePiScript], cwd: process.cwd(), env: process.env },
    vaultRoot: vault,
    runnableAgents: ["Piren"],
  });
  const handle = await server.start();
  base = `http://${handle.hostname}:${handle.port}`;
  // jsdom-relative fetch: prefix the real gateway base so the UNMODIFIED
  // typed client (relative /api URLs) reaches the real server.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
    return realFetch(url, init);
  }) as typeof fetch;
  return server;
}

describe("SR-2: persisted groups fallback candidates end to end (panel -> gateway -> vault)", () => {
  it("persists fallback_order[Piren] = [Vera] after the exact confirmed UI flow", async () => {
    const server = await startServer();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(AgentGroupsPanel, { token: "t", onUnauthorized: () => {} }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
      async function waitFor(what: string, condition: () => boolean): Promise<void> {
        for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
        if (!condition()) throw new Error(`timed out waiting for ${what}`);
      }
      function memberRows(): string[] {
        return Array.from(container.querySelectorAll(".settings-group-detail > ul .settings-agent-fallback-model")).map(
          (n) => n.textContent ?? "",
        );
      }
      async function click(selector: string): Promise<void> {
        await waitFor(selector, () => container.querySelector<HTMLButtonElement>(selector) !== null);
        await act(async () => {
          container.querySelector<HTMLButtonElement>(selector)!.click();
          await tick();
        });
      }
      // Busy-gated controls stay disabled while a mutation round trip is in
      // flight; wait for ENABLED so a click can never be a silent no-op.
      async function clickEnabled(selector: string): Promise<void> {
        await waitFor(`${selector} enabled`, () => {
          const button = container.querySelector<HTMLButtonElement>(selector);
          return button !== null && !button.disabled;
        });
        await act(async () => {
          container.querySelector<HTMLButtonElement>(selector)!.click();
          await tick();
        });
      }
      async function choose(selector: string, value: string): Promise<void> {
        await waitFor(selector, () => container.querySelector<HTMLSelectElement>(selector) !== null);
        await act(async () => {
          const el = container.querySelector<HTMLSelectElement>(selector)!;
          el.value = value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          await tick();
        });
      }

      // 1. Create group `test` behind explicit confirmation.
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>(".settings-groups-new-name")!;
        // jsdom provides HTMLInputElement at runtime; typed through the global
        // record because this jsdom test is excluded from the root tsc pass.
        const inputCtor = (globalThis as unknown as Record<string, { prototype: object }>)[
          "HTMLInputElement"
        ];
        const setter = (
          Object.getOwnPropertyDescriptor(inputCtor.prototype, "value") as {
            set?: (this: Element, value: string) => void;
          }
        ).set;
        if (setter === undefined) throw new Error("missing value setter");
        setter.call(input, "test");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await tick();
      });
      await click(".settings-groups-create");
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      await click(".settings-agent-confirm-save");

      // 2. Open the group detail.
      await click(".settings-group-item");

      // 3. Add both vault-defined members, each awaited to its visible result.
      await choose(".settings-groups-add-select", "Piren");
      await clickEnabled(".settings-groups-add");
      await waitFor("Piren member row", () => memberRows().includes("Piren"));
      await choose(".settings-groups-add-select", "Vera");
      await clickEnabled(".settings-groups-add");
      await waitFor("Vera member row", () => memberRows().includes("Vera"));

      // 4. Build the ordered fallback list for target Piren: [Vera].
      await choose(".settings-groups-fallback-member", "Piren");
      await choose(".settings-groups-fallback-candidate-select", "Vera");
      await click(".settings-groups-fallback-add");
      const order = Array.from(
        container.querySelectorAll(".settings-groups-fallback-list .settings-agent-fallback-model"),
      ).map((n) => (n as HTMLElement).textContent);
      expect(order).toEqual(["Vera"]);

      // 5. Explicit confirmation, then wait for the write + refresh cycle.
      await clickEnabled(".settings-groups-fallback-save");
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.textContent).toContain("Nothing has been written yet.");
      await click(".settings-agent-confirm-save");

      // 6. The REAL persisted YAML must carry the ordered candidate.
      await waitFor("persisted fallback_order entry", () =>
        /fallback_order:[\s\S]*Piren:[\s\S]*-\s*Vera/.test(readFileSync(configPath(), "utf8")),
      );
      const persisted = readFileSync(configPath(), "utf8");
      expect(persisted).toContain("fallback_order:");
      expect(persisted).toMatch(/Piren:[\s\S]*-\s*Vera/);

      // 7. SR-2 lead correction: the post-mutation re-read resets the WHOLE
      // editor — unselected target, no staged list — while the persisted YAML
      // above carries the saved order for an explicit fresh selection.
      await waitFor("editor reset", () => container.querySelector<HTMLSelectElement>(".settings-groups-fallback-member")?.value === "");
      expect(container.querySelector(".settings-groups-fallback-list")).toBeNull();
      expect(container.querySelector(".settings-groups-fallback-candidate-select")).toBeNull();
      const saveAfter = container.querySelector<HTMLButtonElement>(".settings-groups-fallback-save");
      expect(saveAfter?.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await server.close();
    }
  });
});
