import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator-docs contract for the 0.1.6 transport work (T3). Pins the
 * release-critical, user-visible documentation promises: the shipped `/new`
 * and `/compact` text controls and their boundaries, Telegram forum-topic
 * isolation, BotFather Privacy Mode guidance, explicit chat-id
 * authorization, the per_turn context-injection default, and the
 * present/future split for ADR-0040 deferred work. These are documentation
 * promises, not implementation details.
 */

const root = process.cwd();

function read(rel: string): string {
  return existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
}

const TRANSPORTS = read("docs/transports.md");
const CONFIGURATION = read("docs/configuration.md");

describe("transport operator docs (0.1.6)", () => {
  it("documents /new and /compact in both the Telegram and Discord command lists", () => {
    const discordHalf = TRANSPORTS.slice(TRANSPORTS.indexOf("## Discord"));
    const telegramHalf = TRANSPORTS.slice(0, TRANSPORTS.indexOf("## Discord"));
    for (const half of [telegramHalf, discordHalf]) {
      expect(half).toContain("`/new`");
      expect(half).toContain("`/compact`");
    }
  });

  it("documents the exact-only control boundary and the no-resume boundary", () => {
    expect(TRANSPORTS).toContain("Neither command accepts arguments");
    expect(TRANSPORTS).toContain("there is no transport `/resume`");
    expect(CONFIGURATION).toContain("no transport `/resume`");
  });

  it("documents no-active-session behavior without inventing new semantics", () => {
    expect(TRANSPORTS).toMatch(/no live session exists[^\n]*does not create one/i);
  });

  it("documents Telegram forum-topic isolation as routing, not authorization", () => {
    expect(TRANSPORTS).toContain("message_thread_id");
    expect(TRANSPORTS).toContain("no topic allowlist");
    expect(TRANSPORTS).toContain("allowed_chat_ids");
    expect(CONFIGURATION).toContain("does not widen authorization");
  });

  it("documents BotFather Privacy Mode precisely", () => {
    expect(TRANSPORTS).toContain("BotFather Privacy Mode");
    expect(TRANSPORTS).toMatch(/commands, mentions, and replies/);
    expect(TRANSPORTS).toMatch(/explicitly disable Privacy Mode in BotFather/);
    expect(CONFIGURATION).toContain("Privacy Mode");
  });

  it("documents explicit chat-id authorization and local-only tokens", () => {
    expect(TRANSPORTS).toMatch(/explicit chat id in the machine-local `telegram\.allowed_chat_ids`/);
    expect(CONFIGURATION).toMatch(/never in the vault/);
  });

  it("keeps the ADR-0040 present/future split unambiguous", () => {
    expect(TRANSPORTS).toContain("accepted future work (ADR-0040)");
    expect(TRANSPORTS).toContain("not available in the current build");
    // D1 shipped fail-closed one-to-one DM authorization: the DM allowlist
    // is now documented operator surface, and native Discord application
    // commands are the remaining deferred ADR-0040 work.
    expect(TRANSPORTS).toMatch(/Native Discord application commands remain accepted future work/);
    expect(TRANSPORTS).toContain("allowed_dm_user_ids");
    expect(CONFIGURATION).toContain("allowed_dm_user_ids");
  });

  it("keeps per_turn the documented context-injection default with the history caveat", () => {
    expect(CONFIGURATION).toContain("The default remains `per_turn`");
    expect(CONFIGURATION).toMatch(/session_start_only` bounds only the repeated Piren-context copies/);
    expect(CONFIGURATION).not.toMatch(/default\s*(is|:|=)?\s*`?session_start_only/i);
  });
});
