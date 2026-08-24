import { describe, expect, it } from "vitest";
import { parseGroupsDetailResponse, UnauthorizedError } from "../web/src/groups-api.js";

/**
 * SR-1 — the typed browser Groups detail client boundary. The documented
 * GET /api/settings/groups/<group> response carries `roster` as a SIBLING of
 * `group`. The boundary normalizes that real shape and strictly validates
 * enough of it that a compliant payload never reaches render with an
 * undefined roster, while a malformed/missing `group` or `roster` fails
 * boundedly (a thrown bounded error the panel shows as its existing notice)
 * instead of blanking the page.
 */

const VALID = {
  available: true,
  group: {
    name: "dev",
    revision: "rev-1",
    agents: ["kimi"],
    fallbackOrder: { kimi: ["dipu"] },
    findings: [{ severity: "info", kind: "duplicate-across-groups", detail: "Agent 'kimi' is declared in 2 groups." }],
  },
  roster: [
    { name: "kimi", locallyRunnable: true },
    { name: "offline-one", locallyRunnable: false },
  ],
};

describe("parseGroupsDetailResponse (SR-1 sibling-roster normalization)", () => {
  it("normalizes a real compliant sibling-roster response", () => {
    const parsed = parseGroupsDetailResponse(VALID);
    if (!parsed.available) throw new Error("expected available");
    expect(parsed.group.name).toBe("dev");
    expect(Object.keys(parsed.group)).not.toContain("roster");
    expect(parsed.roster).toEqual(VALID.roster);
  });

  it("keeps the typed unavailable result for available:false with a reason", () => {
    const parsed = parseGroupsDetailResponse({ available: false, reason: "Agent group was not found." });
    expect(parsed).toEqual({ available: false, reason: "Agent group was not found." });
  });

  it("fails boundedly when roster is missing entirely (the live crash shape)", () => {
    const { roster: _roster, ...withoutRoster } = VALID;
    void _roster;
    expect(() => parseGroupsDetailResponse(withoutRoster)).toThrow(/could not be read/);
  });

  it("fails boundedly when roster is not an array", () => {
    expect(() => parseGroupsDetailResponse({ ...VALID, roster: "nope" })).toThrow(/could not be read/);
  });

  it("fails boundedly on a malformed roster entry (non-boolean runnable marker)", () => {
    expect(() =>
      parseGroupsDetailResponse({ ...VALID, roster: [{ name: "kimi", locallyRunnable: "yes" }] }),
    ).toThrow(/could not be read/);
  });

  it("fails boundedly when group is missing or malformed", () => {
    const { group: _group, ...withoutGroup } = VALID;
    void _group;
    expect(() => parseGroupsDetailResponse(withoutGroup)).toThrow(/could not be read/);
    expect(() =>
      parseGroupsDetailResponse({
        ...VALID,
        group: { ...VALID.group, agents: "kimi" },
      }),
    ).toThrow(/could not be read/);
    expect(() =>
      parseGroupsDetailResponse({
        ...VALID,
        group: { ...VALID.group, fallbackOrder: { kimi: "dipu" } },
      }),
    ).toThrow(/could not be read/);
  });

  it("fails boundedly when available:false carries no reason", () => {
    expect(() => parseGroupsDetailResponse({ available: false })).toThrow(/could not be read/);
  });

  it("still exports the shared typed UnauthorizedError", () => {
    expect(new UnauthorizedError()).toBeInstanceOf(Error);
  });
});
