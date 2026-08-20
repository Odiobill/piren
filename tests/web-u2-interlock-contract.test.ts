import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webSrc = join(process.cwd(), "web", "src");

/**
 * U2 — composer interlock boundary pins (amendment §6.2). The interlock is a
 * pure browser reflection of broker-authoritative state: the navigator
 * derives it ONLY from the existing activity cards (active broker run) and
 * pending approvals; the composer never fetches/mutates on any transition;
 * the gateway/broker surface is unchanged (no new route/SSE schema/transport,
 * and no dispatch/approval/abort authority alteration).
 */

describe("U2 composer interlock boundaries (static)", () => {
  it("the navigator derives interlock only from broker-authoritative activity and approvals", async () => {
    const navigator = await readFile(join(webSrc, "ConversationNavigator.tsx"), "utf8");
    // The exact broker-state reflection, never a second source of truth.
    expect(navigator).toContain("dockRuns.length > 0 || pendingApprovals.length > 0");
    expect(navigator).toContain("composeInterlockReason");
    expect(navigator).toContain("interlocked={interlocked}");
    expect(navigator).toContain("interlockReason={interlockReason}");
    // Selection change discards session-only state via a fresh composer mount.
    expect(navigator).toContain('key={selection.conversation.id}');
  });

  it("the composer interlock never fetches, stores, polls, or opens a new transport", async () => {
    const composer = await readFile(join(webSrc, "ConversationComposer.tsx"), "utf8");
    // Only the existing send route is used; no new api call surface.
    expect(composer).toContain("sendConversationMessage");
    for (const forbidden of ["localStorage", "sessionStorage", "setInterval", "new EventSource", "WebSocket", "fetch("]) {
      expect(composer, `composer must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the interlock state machine is pure (no DOM/api side effects in the reducer)", async () => {
    const core = await readFile(join(webSrc, "composer-interlock.ts"), "utf8");
    expect(core).toContain("reduceComposerInterlock");
    expect(core).not.toContain("document");
    expect(core).not.toContain("fetch(");
    expect(core).not.toContain("localStorage");
  });

  it("the gateway and broker remain untouched (no interlock concept, no new routes/SSE)", async () => {
    const gateway = await readFile(join(process.cwd(), "src", "gateway-http.ts"), "utf8");
    const broker = await readFile(join(process.cwd(), "src", "conversation-broker.ts"), "utf8");
    for (const content of [gateway, broker]) {
      expect(content).not.toContain("interlock");
    }
    // No new SSE event name introduced for U2 (activity/approval stay the only live signals).
    expect(gateway).not.toContain("composer_interlock");
  });
});
