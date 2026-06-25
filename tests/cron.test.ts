import { describe, expect, it } from "vitest";
import { isScheduleDue, parseSchedule } from "../src/cron.js";

describe("ADR-0019 cron schedule parsing", () => {
  it("parses a five-field cron string into a schedule", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(schedule.raw).toBe("0 7 * * *");
    expect(schedule.describe()).toBe("0 7 * * *");
  });

  it("parses an interval string into a schedule", () => {
    const schedule = parseSchedule("30m");
    expect(schedule.kind).toBe("interval");
    expect(schedule.raw).toBe("30m");
  });

  it("rejects an invalid schedule", () => {
    expect(() => parseSchedule("not a schedule")).toThrow(/invalid cron schedule/i);
  });
});

describe("ADR-0019 cron due detection", () => {
  it("marks an interval job due when elapsed time exceeds the interval", () => {
    const schedule = parseSchedule("30m");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:31:00Z"), lastRun: new Date("2026-06-25T07:00:00Z") })).toBe(true);
  });

  it("does not mark an interval job due within the interval", () => {
    const schedule = parseSchedule("30m");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:10:00Z"), lastRun: new Date("2026-06-25T07:00:00Z") })).toBe(false);
  });

  it("marks an interval job due when there is no previous run", () => {
    const schedule = parseSchedule("6h");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:00:00Z") })).toBe(true);
  });

  it("marks a cron job due at the matching minute with no prior run", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(isScheduleDue({ schedule, now: new Date("2026-06-25T07:00:00Z") })).toBe(true);
  });

  it("does not re-fire a cron job in the same minute it already ran", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(
      isScheduleDue({ schedule, now: new Date("2026-06-25T07:00:30Z"), lastRun: new Date("2026-06-25T07:00:00Z") }),
    ).toBe(false);
  });

  it("does not fire a cron job at a non-matching minute", () => {
    const schedule = parseSchedule("0 7 * * *");
    expect(
      isScheduleDue({ schedule, now: new Date("2026-06-25T08:00:00Z"), lastRun: new Date("2026-06-25T07:00:00Z") }),
    ).toBe(false);
  });
});
