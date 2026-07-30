import { describe, expect, it } from "vitest";
import {
  ALERT_MIRROR_RATE_LIMIT_MS,
  buildAlertNotificationText,
  createAlertMirrorState,
  mirrorStewardAlert,
  resolveAlertMirrorConfig,
  type AlertMirrorSenders,
  type ResolvedAlertMirrorConfig,
} from "../src/alert-mirror.js";
import type { LocalPirenConfig } from "../src/bootstrap.js";

describe("resolveAlertMirrorConfig", () => {
  it("is disabled with no destinations or warnings when alert_mirror is absent", () => {
    const resolved = resolveAlertMirrorConfig({});
    expect(resolved.enabled).toBe(false);
    expect(resolved.destinations).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it("is disabled with no destinations or warnings when enabled is false", () => {
    const config: LocalPirenConfig = {
      alert_mirror: { enabled: false, telegram: { chat_id: 1 } },
      telegram: { bot_token: "token" },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.enabled).toBe(false);
    expect(resolved.destinations).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it("resolves valid telegram and discord destinations with defaults", () => {
    const config: LocalPirenConfig = {
      alert_mirror: {
        enabled: true,
        telegram: { chat_id: 123456789 },
        discord: { channel_id: "999888777" },
      },
      telegram: { bot_token: "tg-token" },
      discord: { bot_token: "dc-token" },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.enabled).toBe(true);
    expect(resolved.minSeverity).toBe("low");
    expect(resolved.includeBody).toBe(false);
    expect(resolved.destinations).toEqual([
      { kind: "telegram", id: "123456789" },
      { kind: "discord", id: "999888777" },
    ]);
    expect(resolved.warnings).toEqual([]);
  });

  it("honors an explicit valid min_severity and include_body", () => {
    const config: LocalPirenConfig = {
      alert_mirror: { enabled: true, min_severity: "high", include_body: true },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.enabled).toBe(true);
    expect(resolved.minSeverity).toBe("high");
    expect(resolved.includeBody).toBe(true);
    expect(resolved.destinations).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it("skips a configured destination whose bot token is missing with a non-secret warning", () => {
    const config: LocalPirenConfig = {
      alert_mirror: {
        enabled: true,
        telegram: { chat_id: 424242 },
        discord: { channel_id: "111" },
      },
      discord: { bot_token: "dc-token" },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.enabled).toBe(true);
    expect(resolved.destinations).toEqual([{ kind: "discord", id: "111" }]);
    expect(resolved.warnings).toHaveLength(1);
    const warning = resolved.warnings[0] ?? "";
    expect(warning).toContain("telegram");
    expect(warning).toContain("bot_token");
    expect(warning).not.toContain("424242");
    expect(warning).not.toContain("dc-token");
  });

  it("treats a whitespace-only token as missing", () => {
    const config: LocalPirenConfig = {
      alert_mirror: { enabled: true, telegram: { chat_id: 7 } },
      telegram: { bot_token: "   " },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.destinations).toEqual([]);
    expect(resolved.warnings).toHaveLength(1);
  });

  it("treats an empty-string destination id as not configured (no warning)", () => {
    const config: LocalPirenConfig = {
      alert_mirror: { enabled: true, telegram: { chat_id: "  " } },
      telegram: { bot_token: "tg-token" },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.enabled).toBe(true);
    expect(resolved.destinations).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it("fails closed to disabled with a deterministic warning on invalid min_severity", () => {
    const config: LocalPirenConfig = {
      alert_mirror: {
        enabled: true,
        min_severity: "critical" as "low",
        telegram: { chat_id: 1 },
      },
      telegram: { bot_token: "tg-token" },
    };
    const resolved = resolveAlertMirrorConfig(config);
    expect(resolved.enabled).toBe(false);
    expect(resolved.destinations).toEqual([]);
    expect(resolved.warnings).toHaveLength(1);
    const warning = resolved.warnings[0] ?? "";
    expect(warning).toContain("invalid min_severity");
    expect(warning).not.toContain("tg-token");
  });
});

describe("buildAlertNotificationText", () => {
  it("returns the default three-facts-in-two-lines payload", () => {
    const text = buildAlertNotificationText({
      severity: "high",
      title: "Disk almost full",
      path: "steward-inbox/alerts/20260730T120000000Z-disk-almost-full.md",
      includeBody: false,
    });
    expect(text).toBe(
      "[high] Disk almost full\n" +
        "steward-inbox/alerts/20260730T120000000Z-disk-almost-full.md",
    );
  });

  it("omits the body by default even when one is provided", () => {
    const text = buildAlertNotificationText({
      severity: "low",
      title: "FYI",
      path: "steward-inbox/alerts/x.md",
      body: "secret details",
      includeBody: false,
    });
    expect(text).not.toContain("secret details");
  });

  it("appends the body only when includeBody is true", () => {
    const text = buildAlertNotificationText({
      severity: "urgent",
      title: "Vault unreachable",
      path: "steward-inbox/alerts/y.md",
      body: "mount check failed",
      includeBody: true,
    });
    expect(text).toBe("[urgent] Vault unreachable\nsteward-inbox/alerts/y.md\n\nmount check failed");
  });

  it("treats a blank body as absent even when includeBody is true", () => {
    const text = buildAlertNotificationText({
      severity: "normal",
      title: "n",
      path: "p.md",
      body: "   ",
      includeBody: true,
    });
    expect(text).toBe("[normal] n\np.md");
  });
});

function enabledConfig(overrides: Partial<ResolvedAlertMirrorConfig> = {}): ResolvedAlertMirrorConfig {
  return {
    enabled: true,
    minSeverity: "low",
    includeBody: false,
    destinations: [
      { kind: "telegram", id: "111" },
      { kind: "discord", id: "222" },
    ],
    warnings: [],
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    alertId: "alert-1",
    severity: "normal" as const,
    title: "Test alert",
    path: "steward-inbox/alerts/alert-1.md",
    body: "body text",
    notify: true,
    config: enabledConfig(),
    senders: {} as AlertMirrorSenders,
    state: createAlertMirrorState(),
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    ...overrides,
  };
}

describe("mirrorStewardAlert", () => {
  it("is a no-op returning [] without state mutation when notify is false", async () => {
    const input = baseInput({ notify: false });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries).toEqual([]);
    expect(input.state.seenAlertIds.size).toBe(0);
    expect(input.state.lastSentAt.size).toBe(0);
  });

  it("is a no-op returning [] without state mutation when config is disabled", async () => {
    const input = baseInput({ config: enabledConfig({ enabled: false }) });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries).toEqual([]);
    expect(input.state.seenAlertIds.size).toBe(0);
  });

  it("is a no-op returning [] without state mutation below the severity floor", async () => {
    const input = baseInput({
      severity: "normal",
      config: enabledConfig({ minSeverity: "high" }),
    });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries).toEqual([]);
    expect(input.state.seenAlertIds.size).toBe(0);
    expect(input.state.lastSentAt.size).toBe(0);
  });

  it("mirrors an alert exactly at the inclusive severity floor", async () => {
    const sent: Array<{ id: string; text: string }> = [];
    const input = baseInput({
      severity: "high",
      config: enabledConfig({ minSeverity: "high", destinations: [{ kind: "telegram", id: "111" }] }),
      senders: {
        telegram: async (id: string, text: string) => {
          sent.push({ id, text });
        },
      },
    });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries).toEqual([{ destination: { kind: "telegram", id: "111" }, outcome: "sent" }]);
    expect(sent).toHaveLength(1);
  });

  it("sends the default two-line payload and records a successful-send timestamp", async () => {
    const sent: Array<{ id: string; text: string }> = [];
    const input = baseInput({
      config: enabledConfig({ destinations: [{ kind: "telegram", id: "111" }] }),
      senders: {
        telegram: async (id: string, text: string) => {
          sent.push({ id, text });
        },
      },
    });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries).toEqual([{ destination: { kind: "telegram", id: "111" }, outcome: "sent" }]);
    expect(sent).toEqual([
      { id: "111", text: "[normal] Test alert\nsteward-inbox/alerts/alert-1.md" },
    ]);
    expect(input.state.lastSentAt.get("telegram:111")).toBe(
      new Date("2026-07-30T12:00:00.000Z").getTime(),
    );
    expect(input.state.seenAlertIds.has("alert-1")).toBe(true);
  });

  it("includes the body in the sender text only when includeBody is true", async () => {
    const sent: string[] = [];
    const input = baseInput({
      config: enabledConfig({ includeBody: true, destinations: [{ kind: "telegram", id: "111" }] }),
      senders: {
        telegram: async (_id: string, text: string) => {
          sent.push(text);
        },
      },
    });
    await mirrorStewardAlert(input);
    expect(sent[0]).toContain("body text");
  });

  it("reports skipped-duplicate per destination for a repeated alert id and does not resend", async () => {
    let calls = 0;
    const senders: AlertMirrorSenders = {
      telegram: async () => {
        calls += 1;
      },
      discord: async () => {
        calls += 1;
      },
    };
    const state = createAlertMirrorState();
    const first = await mirrorStewardAlert(baseInput({ senders, state }));
    expect(first.every((d) => d.outcome === "sent")).toBe(true);
    expect(calls).toBe(2);
    const second = await mirrorStewardAlert(baseInput({ senders, state }));
    expect(second).toEqual([
      {
        destination: { kind: "telegram", id: "111" },
        outcome: "skipped-duplicate",
        reason: "alert already mirrored in this process",
      },
      {
        destination: { kind: "discord", id: "222" },
        outcome: "skipped-duplicate",
        reason: "alert already mirrored in this process",
      },
    ]);
    expect(calls).toBe(2);
  });

  it("drops a send inside the fixed 5s per-destination window (drop-not-queue)", async () => {
    let calls = 0;
    const senders: AlertMirrorSenders = {
      telegram: async () => {
        calls += 1;
      },
    };
    const state = createAlertMirrorState();
    const config = enabledConfig({ destinations: [{ kind: "telegram", id: "111" }] });
    const t0 = new Date("2026-07-30T12:00:00.000Z");
    await mirrorStewardAlert(baseInput({ alertId: "a1", config, senders, state, now: () => t0 }));
    const within = await mirrorStewardAlert(
      baseInput({
        alertId: "a2",
        config,
        senders,
        state,
        now: () => new Date(t0.getTime() + ALERT_MIRROR_RATE_LIMIT_MS - 1),
      }),
    );
    expect(within).toEqual([
      {
        destination: { kind: "telegram", id: "111" },
        outcome: "skipped-rate-limited",
        reason: "within per-destination rate limit",
      },
    ]);
    expect(calls).toBe(1);
  });

  it("allows a send exactly at the 5s boundary", async () => {
    let calls = 0;
    const senders: AlertMirrorSenders = {
      telegram: async () => {
        calls += 1;
      },
    };
    const state = createAlertMirrorState();
    const config = enabledConfig({ destinations: [{ kind: "telegram", id: "111" }] });
    const t0 = new Date("2026-07-30T12:00:00.000Z");
    await mirrorStewardAlert(baseInput({ alertId: "a1", config, senders, state, now: () => t0 }));
    const atBoundary = await mirrorStewardAlert(
      baseInput({
        alertId: "a2",
        config,
        senders,
        state,
        now: () => new Date(t0.getTime() + ALERT_MIRROR_RATE_LIMIT_MS),
      }),
    );
    expect(atBoundary).toEqual([{ destination: { kind: "telegram", id: "111" }, outcome: "sent" }]);
    expect(calls).toBe(2);
  });

  it("updates the per-destination timestamp only after a successful send", async () => {
    let reject = true;
    const senders: AlertMirrorSenders = {
      telegram: async () => {
        if (reject) throw new Error("raw platform error with token abc123");
      },
    };
    const state = createAlertMirrorState();
    const config = enabledConfig({ destinations: [{ kind: "telegram", id: "111" }] });
    const t0 = new Date("2026-07-30T12:00:00.000Z");
    const failed = await mirrorStewardAlert(baseInput({ alertId: "a1", config, senders, state, now: () => t0 }));
    expect(failed).toEqual([
      { destination: { kind: "telegram", id: "111" }, outcome: "failed", reason: "sender rejected" },
    ]);
    expect(state.lastSentAt.size).toBe(0);
    // A failed send must not start the rate-limit window: the next attempt goes out.
    reject = false;
    const retry = await mirrorStewardAlert(baseInput({ alertId: "a2", config, senders, state, now: () => t0 }));
    expect(retry).toEqual([{ destination: { kind: "telegram", id: "111" }, outcome: "sent" }]);
  });

  it("normalizes sender failures: no raw exception text in the record", async () => {
    const senders: AlertMirrorSenders = {
      telegram: async () => {
        throw new Error("raw platform error with token abc123");
      },
    };
    const input = baseInput({
      config: enabledConfig({ destinations: [{ kind: "telegram", id: "111" }] }),
      senders,
    });
    const deliveries = await mirrorStewardAlert(input);
    const serialized = JSON.stringify(deliveries);
    expect(serialized).not.toContain("raw platform error");
    expect(serialized).not.toContain("abc123");
  });

  it("reports skipped-no-sender with a kind-qualified reason and no destination id", async () => {
    const input = baseInput({ senders: {} });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries).toEqual([
      {
        destination: { kind: "telegram", id: "111" },
        outcome: "skipped-no-sender",
        reason: "no telegram sender configured",
      },
      {
        destination: { kind: "discord", id: "222" },
        outcome: "skipped-no-sender",
        reason: "no discord sender configured",
      },
    ]);
    for (const d of deliveries) {
      expect(d.reason ?? "").not.toContain(d.destination.id);
    }
  });

  it("qualifies rate-limit keys by kind so identical ids do not collide", async () => {
    const sent: string[] = [];
    const senders: AlertMirrorSenders = {
      telegram: async (id: string) => {
        sent.push(`telegram:${id}`);
      },
      discord: async (id: string) => {
        sent.push(`discord:${id}`);
      },
    };
    const input = baseInput({
      config: enabledConfig({
        destinations: [
          { kind: "telegram", id: "same" },
          { kind: "discord", id: "same" },
        ],
      }),
      senders,
    });
    const deliveries = await mirrorStewardAlert(input);
    expect(deliveries.every((d) => d.outcome === "sent")).toBe(true);
    expect(sent).toEqual(["telegram:same", "discord:same"]);
    expect(input.state.lastSentAt.has("telegram:same")).toBe(true);
    expect(input.state.lastSentAt.has("discord:same")).toBe(true);
  });

  it("keeps destinations independent: one failure does not prevent other sends", async () => {
    let discordSent = false;
    const senders: AlertMirrorSenders = {
      telegram: async () => {
        throw new Error("boom");
      },
      discord: async () => {
        discordSent = true;
      },
    };
    const deliveries = await mirrorStewardAlert(baseInput({ senders }));
    expect(deliveries).toEqual([
      { destination: { kind: "telegram", id: "111" }, outcome: "failed", reason: "sender rejected" },
      { destination: { kind: "discord", id: "222" }, outcome: "sent" },
    ]);
    expect(discordSent).toBe(true);
  });

  it("applies the rate limit per destination, not globally", async () => {
    const senders: AlertMirrorSenders = {
      telegram: async () => undefined,
      discord: async () => undefined,
    };
    const state = createAlertMirrorState();
    const t0 = new Date("2026-07-30T12:00:00.000Z");
    const first = await mirrorStewardAlert(baseInput({ alertId: "a1", senders, state, now: () => t0 }));
    expect(first.every((d) => d.outcome === "sent")).toBe(true);
  });
});
