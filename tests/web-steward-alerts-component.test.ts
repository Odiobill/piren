// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StewardAlerts } from "../web/src/StewardAlerts.js";
import { fetchStewardAlert, fetchStewardAlerts } from "../web/src/api.js";

/**
 * Correction S2 — the Steward Alerts module renders the historical
 * `status: resolved` grammar truthfully: a resolved terminal label with its
 * strictly decoded resolved time, no workbench closure claim, and no
 * Close alert control (a legacy resolved record is not closeable).
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchStewardAlerts: vi.fn(),
    fetchStewardAlert: vi.fn(),
    closeStewardAlert: vi.fn(),
  };
});

const resolvedSummary = {
  path: "steward-inbox/alerts/historical-resolved.md",
  id: "20260804T110454270Z-credential-exposed-in-team-kimi-config-yml",
  severity: "urgent" as const,
  status: "resolved" as const,
  title: "Credential exposed in team/kimi/config.yml",
  created: "2026-08-04T11:04:54.270Z",
  resolvedAt: "2026-08-04T11:19:00Z",
};

function mockAlertApi() {
  vi.mocked(fetchStewardAlerts).mockResolvedValue({ attentionCount: 0, alerts: [resolvedSummary] });
  vi.mocked(fetchStewardAlert).mockResolvedValue({ ...resolvedSummary, content: "# Credential exposed" });
}

describe("StewardAlerts historical resolved rendering", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAlertApi();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders a truthful resolved terminal label and no close control", async () => {
    await act(async () => {
      root.render(createElement(StewardAlerts, {
        token: "t",
        onUnauthorized: () => {},
        onValidated: () => {},
        reloadKey: 0,
        onClosed: () => {},
      }));
    });

    const item = container.querySelector<HTMLButtonElement>(".steward-alert-list button");
    expect(item).not.toBeNull();
    await act(async () => item!.click());

    const detail = container.querySelector(".steward-alert-detail");
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain("Resolved");
    expect(detail!.textContent).toContain("2026-08-04T11:19:00Z");
    expect(detail!.textContent).not.toContain("Close alert");
    expect(fetchStewardAlert).toHaveBeenCalledWith(resolvedSummary.path, "t");
  });
});
