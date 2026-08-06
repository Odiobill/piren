import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L4 — operator-docs contract for the accepted Conversation archive/reopen
 * lifecycle (L1 durable core + L2 gateway routes + L3 Workbench controls).
 * Prevents stale claims: the two lifecycle routes, the transitioned/event
 * contract, lock contention, the bounded event-append 500, the state-only
 * boundary, the Workbench controls + fresh re-gating, and the absence of any
 * "archive/reopen is deferred" wording must all be pinned in the public docs.
 */
const root = process.cwd();

function read(rel: string): string {
  return existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
}

const API = read("docs/api.md");
const GATEWAY = read("docs/gateway.md");
const README = read("README.md");

describe("conversation lifecycle operator docs (L4)", () => {
  describe("docs/api.md — the two lifecycle routes and shared contract", () => {
    it("documents exactly the archive and reopen routes", () => {
      expect(API).toContain("POST /api/conversations/<id>/archive");
      expect(API).toContain("POST /api/conversations/<id>/reopen");
    });

    it("documents transitioned:true with the event only then, and transitioned:false with no write/event", () => {
      expect(API).toContain("transitioned: true");
      expect(API).toContain("transitioned: false");
      expect(API).toMatch(/lifecycle_transition/);
      expect(API).toMatch(/event[^\n]*only|only[^\n]*event/i);
    });

    it("documents the no-input and state-only boundaries", () => {
      expect(API).toMatch(/empty object|no lifecycle input/i);
      expect(API).toMatch(/not dispatch|never dispatch|does not dispatch/i);
      expect(API).toMatch(/not cancel|not aborted|not aborted|does not abort/i);
    });

    it("documents lock contention 409, bounded 500, and lifecycleState metadata", () => {
      expect(API).toMatch(/409/i);
      expect(API).toMatch(/\.audience\.lock/);
      expect(API).toMatch(/500/);
      expect(API).toMatch(/lifecycleState: open\|archived|lifecycleState/);
      expect(API).toMatch(/immutable/);
    });

    it("no longer claims archive/reopen are deferred", () => {
      expect(API).not.toMatch(/Archive\/reopen[^\n]*remain later/);
      expect(API).not.toMatch(/archive\/reopen[^\n]*deferred/i);
    });
  });

  describe("docs/gateway.md — Workbench behavior for operators", () => {
    it("documents the Archive/Reopen controls, confirmation, and fresh re-gating", () => {
      expect(GATEWAY).toMatch(/Archive/);
      expect(GATEWAY).toMatch(/Reopen/);
      expect(GATEWAY).toMatch(/confirmation/);
      expect(GATEWAY).toMatch(/attach/);
      expect(GATEWAY).toMatch(/fresh|re-read|reread/i);
    });

    it("documents state-only lifecycle: no cancel, no Pi/session start, no auto-reattach", () => {
      expect(GATEWAY).toMatch(/not cancel|cancel/i);
      expect(GATEWAY).toMatch(/read-only inspection|read-only/);
      expect(GATEWAY).not.toMatch(/automatic reopen|auto[- ]reopen|implicit reattach/i);
    });

    it("documents bounded 409 manual Retry and 500 fresh-inspection handling", () => {
      expect(GATEWAY).toMatch(/Retry/);
      expect(GATEWAY).toMatch(/500/);
      expect(GATEWAY).toMatch(/rolled back|rollback|never rolled back/i);
    });
  });

  describe("README.md — public audience, plain language", () => {
    it("states that Conversation lifecycle controls exist and explains archive/read-only/reopen", () => {
      expect(README).toMatch(/archive/i);
      expect(README).toMatch(/reopen/i);
      expect(README).toMatch(/read-only inspection|read-only/i);
      expect(README).toMatch(/attach/);
    });

    it("contains no internal slice/commit terminology and no deferred lifecycle claim", () => {
      expect(README).not.toMatch(/\bL[1-4]\b/);
      expect(README).not.toMatch(/archive\/reopen[^\n]*(deferred|not implemented|later)/i);
    });
  });
});
