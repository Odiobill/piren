import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L4 landing-page static regression: the five coordination/fallback/transport/
 * multi-device capability areas and their conservative boundaries.
 */
const root = process.cwd();
const landing = readFileSync(join(root, "site/index.html"), "utf8");

describe("landing L4 capability sections", () => {
  it("presents the four added capability sections", () => {
    expect(landing).toContain('id="groups"');
    expect(landing).toContain('id="coordination"');
    expect(landing).toContain('id="fallback"');
    expect(landing).toContain('id="transports"');
  });

  it("pins groups, coordination, fallback, and transport boundaries", () => {
    // Groups: procedures, not execution authority; read-only recommendation.
    expect(landing).toContain("never reassigns or reroutes work");
    // Coordination: no automatic reassignment / resumption / cross-agent reroute.
    expect(landing).toContain("no automatic reassignment");
    expect(landing).toContain("resumption of interrupted work");
    // Fallback: same-session, no redispatch/reroute.
    expect(landing).toContain("Nothing re-dispatches or reroutes");
    expect(landing).toContain("on the same session");
    // Coordination: no silent retry.
    expect(landing).toContain("no silent retry");
    // Transports: machine-local fail-closed authorization.
    expect(landing).toContain("fail-closed");
  });

  it("rewrites multi-device copy with conservative boundaries", () => {
    expect(landing).toContain("no automatic failover");
    expect(landing).toContain("no silent re-execution");
    expect(landing).toContain("no resumed interrupted work");
    expect(landing).toContain("no cross-agent rerouting");
    // Async-synced vault copies do not provide a distributed claim-exclusivity
    // guarantee.
    expect(landing).toContain("distributed claim-exclusivity guarantee");
    // The legacy auto-continuation claim must be gone.
    expect(landing).not.toContain("the work continues on another");
  });
});
