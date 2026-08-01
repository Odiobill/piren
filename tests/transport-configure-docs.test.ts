import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator-docs contract for the guided local transport configuration
 * commands (ADR-0040): `piren telegram configure` / `piren discord configure`.
 * Pins the command surface, the local-only secret boundary, the redacted
 * preview + explicit confirmation, the no-daemon/no-service/no-platform-contact
 * boundary, the Discord Developer Portal and Telegram BotFather prerequisites,
 * and the safe foreground verification sequence. Also guards against stale
 * claims that the configure commands are unavailable.
 */

const root = process.cwd();

function read(rel: string): string {
  return existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
}

const TRANSPORTS = read("docs/transports.md");
const CONFIGURATION = read("docs/configuration.md");

describe("guided transport configuration docs", () => {
  it("documents both configure commands", () => {
    expect(TRANSPORTS).toContain("piren telegram configure");
    expect(TRANSPORTS).toContain("piren discord configure");
  });

  it("documents the local-only secret boundary", () => {
    expect(TRANSPORTS).toMatch(/~\/\.config\/piren\/config\.yml/);
    expect(TRANSPORTS).toMatch(/never[^\n]*vault|vault[^\n]*never/i);
  });

  it("documents the redacted preview and explicit confirmation", () => {
    expect(TRANSPORTS).toMatch(/redact/i);
    expect(TRANSPORTS).toMatch(/confirm/i);
  });

  it("documents that configure never starts a daemon, service, or platform contact", () => {
    expect(TRANSPORTS).toMatch(/does not start|without starting|no service/i);
    expect(TRANSPORTS).toMatch(/does not contact|without contacting|no[^\n]*platform[^\n]*contact/i);
  });

  it("documents Discord Developer Portal prerequisites including the Message Content intent", () => {
    expect(TRANSPORTS).toMatch(/Developer Portal/i);
    expect(TRANSPORTS).toMatch(/Message Content/i);
    expect(TRANSPORTS).toMatch(/Developer Mode/i);
    expect(TRANSPORTS).toMatch(/server/i);
    expect(TRANSPORTS).toMatch(/not a user ID|user ID/i);
  });

  it("documents Telegram BotFather prerequisites", () => {
    expect(TRANSPORTS).toMatch(/BotFather/);
    expect(TRANSPORTS).toMatch(/Privacy Mode/);
  });

  it("documents the safe foreground verification sequence", () => {
    expect(TRANSPORTS).toMatch(/piren doctor/);
    expect(TRANSPORTS).toMatch(/\/start/);
    expect(TRANSPORTS).toMatch(/service-management/);
  });

  it("does not claim the configure commands are unavailable", () => {
    expect(TRANSPORTS).not.toMatch(/configure[^\n]*not available in the current build/i);
  });

  it("documents the guided Discord configure DM collection as an optional explicit one-to-one user allowlist", () => {
    // D2: the guided flow may collect allowed_dm_user_ids. Docs must not
    // claim it cannot, and must keep the fail-closed one-to-one framing.
    expect(TRANSPORTS).not.toMatch(/configure[^\n]*does not collect/i);
    expect(TRANSPORTS).toMatch(/one-to-one DM user/);
    expect(TRANSPORTS).toMatch(/omitted[^\n]*(denied|deny)|every DM is denied/i);
    expect(TRANSPORTS).not.toMatch(/group DM(s)? (are )?supported/i);
  });

  it("points the configuration reference at the guided commands", () => {
    expect(CONFIGURATION).toContain("piren telegram configure");
    expect(CONFIGURATION).toContain("piren discord configure");
  });
});
