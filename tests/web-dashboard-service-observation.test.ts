// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for component-test state flushing.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardView } from "../web/src/DashboardView.js";
import {
  fetchConversationAgents,
  fetchServiceStatus,
  startConversation,
  UnauthorizedError,
} from "../web/src/api.js";
import type { ServiceStatusSnapshot } from "../web/src/service-observation.js";

/**
 * D2.3 — Dashboard managed service observation rendering (accepted contract:
 * Projects/Piren/workbench-dashboard-service-observability-contract.md).
 * The Dashboard performs the existing authenticated roster read first; only
 * after it succeeds (the sole "Gateway connection — Connected" fact) it makes
 * ONE fresh service-observation read. The observation group is visually and
 * semantically separate, names the source and sampled time, renders the three
 * fixed targets in contract order with truthful labels, styles unknown /
 * unavailable as caution (never success), and on failure preserves the
 * Gateway fact with a bounded unavailable message plus one explicit manual
 * retry that fetches only a fresh observation. No polling, storage, SSE,
 * WebSocket, automatic retry, or stale snapshot reuse.
 */

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return {
    ...actual,
    fetchConversationAgents: vi.fn(),
    fetchServiceStatus: vi.fn(),
    startConversation: vi.fn(),
  };
});

const ROSTER = {
  agents: [
    { name: "dipu", online: true },
    { name: "kimi", online: true },
  ],
};

const SNAPSHOT: ServiceStatusSnapshot = {
  observedAt: "2026-08-16T12:00:00.000Z",
  manager: "systemd-user",
  targets: [
    { target: "telegram", state: "active" },
    { target: "discord", state: "inactive" },
    { target: "scheduler", state: "not-installed" },
  ],
};

const CAUTION_SNAPSHOT: ServiceStatusSnapshot = {
  observedAt: "2026-08-16T12:05:00.000Z",
  manager: "tmux-cron",
  targets: [
    { target: "telegram", state: "unknown" },
    { target: "discord", state: "unavailable" },
    { target: "scheduler", state: "active" },
  ],
};

// The module mock above replaces fetchServiceStatus for the component tests;
// the fetch-helper tests below exercise the REAL implementation over a
// stubbed global fetch.
const actualApi = await vi.importActual<typeof import("../web/src/api.js")>("../web/src/api.js");

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDashboard(reloadKey = 0, onUnauthorized: () => void = () => {}): void {
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(DashboardView, {
        token: "test-token",
        onUnauthorized,
        onValidated: () => {},
        onOpenConversation: () => {},
        reloadKey,
      }),
    );
  });
}

function rerenderDashboard(reloadKey: number): void {
  act(() => {
    root.render(
      createElement(DashboardView, {
        token: "test-token",
        onUnauthorized: () => {},
        onValidated: () => {},
        onOpenConversation: () => {},
        reloadKey,
      }),
    );
  });
}

function observationGroup(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".dashboard-service-observation");
  if (el === null) throw new Error("observation group missing");
  return el;
}

function observationEntries(): Array<{ name: string; label: string; className: string }> {
  return Array.from(observationGroup().querySelectorAll(".dashboard-service-observation-list li")).map((li) => {
    const name = li.querySelector(".dashboard-service-name")?.textContent ?? "";
    const chip = li.querySelector(".agent-status");
    return { name, label: chip?.textContent ?? "", className: chip?.className ?? "" };
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.mocked(fetchConversationAgents).mockReset();
  vi.mocked(fetchServiceStatus).mockReset();
  vi.mocked(startConversation).mockReset();
  vi.mocked(fetchConversationAgents).mockResolvedValue(ROSTER);
  vi.mocked(fetchServiceStatus).mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("DashboardView service observation (D2.3)", () => {
  it("fetches the observation exactly once, only after the roster read succeeds", async () => {
    let resolveRoster: ((value: typeof ROSTER) => void) | undefined;
    vi.mocked(fetchConversationAgents).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRoster = resolve;
        }),
    );
    renderDashboard();
    await flush();
    // Roster still pending: no observation read may start.
    expect(vi.mocked(fetchServiceStatus)).not.toHaveBeenCalled();
    await act(async () => {
      resolveRoster?.(ROSTER);
    });
    await flush();
    expect(vi.mocked(fetchConversationAgents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchServiceStatus)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchServiceStatus)).toHaveBeenCalledWith("test-token", expect.anything());
  });

  it("never fabricates Gateway Connected or invokes observation when the roster read fails", async () => {
    vi.mocked(fetchConversationAgents).mockRejectedValueOnce(new Error("gateway unavailable"));
    renderDashboard();
    await flush();
    expect(vi.mocked(fetchServiceStatus)).not.toHaveBeenCalled();
    expect(container.querySelector(".dashboard-services")).toBeNull();
    expect(container.textContent).not.toContain("Connected");
    expect(container.textContent).toContain("gateway unavailable");
  });

  it("renders Gateway connection separately from the observation group with source and sampled time", async () => {
    renderDashboard();
    await flush();
    const services = container.querySelector(".dashboard-services");
    expect(services?.textContent).toContain("Gateway");
    expect(services?.textContent).toContain("Connected");
    const group = observationGroup();
    // Accessible, clearly separate group heading.
    const heading = group.querySelector("h4");
    expect(heading?.textContent).toBe("Managed service observation");
    expect(group.getAttribute("aria-labelledby")).toBe(heading?.id ?? "");
    // Source (gateway-sampled manager) and sampled time are named.
    expect(group.textContent).toContain("systemd (user)");
    const time = group.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2026-08-16T12:00:00.000Z");
    expect(time?.textContent).toContain("2026-08-16T12:00:00.000Z");
  });

  it("renders the three fixed targets in contract order with truthful labels", async () => {
    renderDashboard();
    await flush();
    const entries = observationEntries();
    expect(entries.map((e) => e.name)).toEqual(["Telegram", "Discord", "Scheduler"]);
    expect(entries.map((e) => e.label)).toEqual(["Active", "Inactive", "Not installed"]);
    expect(entries[0]?.className).toContain("status-ok");
    // No gateway target, no success vocabulary beyond Active.
    const text = observationGroup().textContent?.toLowerCase() ?? "";
    expect(text).not.toMatch(/healthy|online|running/);
  });

  it("renders unknown and unavailable as visible caution states, never success-styled", async () => {
    vi.mocked(fetchServiceStatus).mockResolvedValue(CAUTION_SNAPSHOT);
    renderDashboard();
    await flush();
    const entries = observationEntries();
    expect(entries.map((e) => e.label)).toEqual(["Unknown", "Manager unavailable", "Active"]);
    expect(entries[0]?.className).toContain("status-warn");
    expect(entries[1]?.className).toContain("status-warn");
    expect(entries[0]?.className).not.toContain("status-ok");
    expect(entries[1]?.className).not.toContain("status-ok");
    expect(entries[2]?.className).toContain("status-ok");
  });

  it("observation failure preserves Gateway Connected and shows the bounded unavailable UI with one manual retry", async () => {
    vi.mocked(fetchServiceStatus).mockRejectedValue(new Error("service status HTTP 503"));
    renderDashboard();
    await flush();
    // The D1 gateway-connection fact is preserved untouched.
    const services = container.querySelector(".dashboard-services");
    expect(services?.textContent).toContain("Gateway");
    expect(services?.textContent).toContain("Connected");
    // Bounded failure presentation: no target labels, no invented state.
    const group = observationGroup();
    expect(group.textContent).toContain("Service observation unavailable");
    expect(group.querySelector(".dashboard-service-observation-list")).toBeNull();
    expect(group.textContent).not.toContain("Telegram");
    expect(group.textContent?.toLowerCase() ?? "").not.toMatch(/healthy|online|running/);
    // No automatic retry.
    expect(vi.mocked(fetchServiceStatus)).toHaveBeenCalledTimes(1);

    // One explicit manual retry fetches ONLY a fresh observation.
    vi.mocked(fetchServiceStatus).mockResolvedValue(SNAPSHOT);
    const retry = Array.from(group.querySelectorAll("button")).find((b) => b.textContent === "Retry service observation");
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    await flush();
    expect(vi.mocked(fetchServiceStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchConversationAgents)).toHaveBeenCalledTimes(1);
    expect(observationEntries().map((e) => e.name)).toEqual(["Telegram", "Discord", "Scheduler"]);
  });

  it("a failed refresh never shows stale target values from an earlier snapshot", async () => {
    renderDashboard();
    await flush();
    expect(observationEntries().map((e) => e.label)).toEqual(["Active", "Inactive", "Not installed"]);

    // A shell-triggered reload re-reads the roster, then the observation
    // fails: the old snapshot's labels must disappear, not linger.
    vi.mocked(fetchServiceStatus).mockRejectedValue(new Error("service status HTTP 503"));
    rerenderDashboard(1);
    await flush();
    const group = observationGroup();
    expect(group.textContent).toContain("Service observation unavailable");
    expect(group.querySelector(".dashboard-service-observation-list")).toBeNull();
    expect(group.textContent).not.toContain("Not installed");
    // Gateway connection fact still stands (the roster re-read succeeded).
    expect(container.querySelector(".dashboard-services")?.textContent).toContain("Connected");
  });

  it("routes an observation 401 through the existing unauthorized path", async () => {
    const unauthorized: string[] = [];
    vi.mocked(fetchServiceStatus).mockRejectedValue(new UnauthorizedError());
    renderDashboard(0, () => unauthorized.push("called"));
    await flush();
    expect(unauthorized).toEqual(["called"]);
    // No fabricated observation group content.
    expect(container.textContent).not.toContain("Active");
  });

  it("keeps D1 selection/start behavior intact alongside the observation group", async () => {
    renderDashboard();
    await flush();
    // Observation rendered…
    expect(observationEntries().length).toBe(3);
    // …and the D1 agent cards + start flow are unchanged.
    const dipu = container.querySelector<HTMLButtonElement>('[data-agent="dipu"]');
    expect(dipu).not.toBeNull();
    await act(async () => {
      dipu?.click();
    });
    const start = container.querySelector<HTMLButtonElement>(".dashboard-start");
    expect(start?.disabled).toBe(false);
  });
});

describe("fetchServiceStatus (D2.3)", () => {
  beforeEach(() => {
    // Restore the real helper for these tests (the outer mock serves the
    // component tests only).
    vi.mocked(fetchServiceStatus).mockImplementation(actualApi.fetchServiceStatus);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fake = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fake);
    return fake;
  }

  it("sends the in-memory Bearer header to the observation endpoint and parses the snapshot", async () => {
    const fake = stubFetch(200, SNAPSHOT);
    const snapshot = await fetchServiceStatus("secret-token");
    expect(snapshot).toEqual(SNAPSHOT);
    expect(fake).toHaveBeenCalledTimes(1);
    const [path, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/services/status");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("surfaces 401 through UnauthorizedError", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(fetchServiceStatus("bad-token")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("treats a non-200 status (including the bounded 503) as failure", async () => {
    stubFetch(503, { error: "service observation unavailable" });
    await expect(fetchServiceStatus("secret-token")).rejects.toThrow(/503/);
    stubFetch(500, { error: "internal" });
    await expect(fetchServiceStatus("secret-token")).rejects.toThrow(/500/);
  });

  it("treats a 200 with a bad payload as failure (never an invented state)", async () => {
    stubFetch(200, { observedAt: "2026-08-16T12:00:00.000Z", manager: "kubernetes", targets: [] });
    await expect(fetchServiceStatus("secret-token")).rejects.toThrow();
  });
});
