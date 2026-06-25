/**
 * Vault-backed cron (ADR-0019).
 *
 * Core scheduling logic, separated from Pi adaptation. This module is
 * callable directly from tests with a fake filesystem. Schedules are
 * deliberately boring: five-field cron strings (minute granularity) or
 * simple interval syntax. No exactly-once guarantees, no central DB.
 */

export type CronScheduleKind = "cron" | "interval";

export interface CronSchedule {
  raw: string;
  kind: CronScheduleKind;
  /** Human-readable, stable rendering used for both describe() and logs. */
  describe(): string;
}

const INTERVAL_PATTERN = /^(\d+)([smhd])$/;

const UNIT_TO_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Milliseconds for an interval schedule. Returns undefined for cron schedules.
 */
export function intervalMs(schedule: CronSchedule): number | undefined {
  if (schedule.kind !== "interval") return undefined;
  const match = schedule.raw.match(INTERVAL_PATTERN);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) return undefined;
  const multiplier = UNIT_TO_MS[unit];
  return Number.isFinite(multiplier) ? amount * multiplier : undefined;
}

/**
 * Whether a five-field cron field matches a given calendar value.
 * Supports "*" (any) and a single integer. Ranges, lists, and steps are
 * out of RC scope (ADR-0019: "simple schedules").
 */
function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  return Number(field) === value;
}

/**
 * Whether a five-field cron schedule fires at the given instant (UTC).
 */
function cronMatchesAt(schedule: CronSchedule, date: Date): boolean {
  if (schedule.kind !== "cron") return false;
  const fields = schedule.raw.split(/\s+/);
  const minute = fields[0];
  const hour = fields[1];
  const dom = fields[2];
  const month = fields[3];
  const dow = fields[4];
  return (
    cronFieldMatches(minute ?? "", date.getUTCMinutes()) &&
    cronFieldMatches(hour ?? "", date.getUTCHours()) &&
    cronFieldMatches(dom ?? "", date.getUTCDate()) &&
    cronFieldMatches(month ?? "", date.getUTCMonth() + 1) &&
    cronFieldMatches(dow ?? "", date.getUTCDay())
  );
}

export interface IsScheduleDueOptions {
  schedule: CronSchedule;
  now: Date;
  /** Previous successful/recorded run. When absent, the job is due immediately. */
  lastRun?: Date;
}

/**
 * Whether a job is due at `now`, given its schedule and last run time.
 *
 * Interval schedules are due when (now - lastRun) >= interval, or immediately
 * when there is no last run. Cron schedules are due when the cron expression
 * matches `now` AND either there is no last run or the last run was strictly
 * before the current minute (so a job that already ran in the current minute
 * is not re-triggered within the same minute).
 */
export function isScheduleDue(options: IsScheduleDueOptions): boolean {
  const { schedule, now, lastRun } = options;

  if (schedule.kind === "interval") {
    const ms = intervalMs(schedule);
    if (ms === undefined) return false;
    if (!lastRun) return true;
    return now.getTime() - lastRun.getTime() >= ms;
  }

  if (!cronMatchesAt(schedule, now)) return false;
  if (!lastRun) return true;
  // Align both to the minute: a job is due at most once per matching minute.
  const lastMinute = Math.floor(lastRun.getTime() / 60_000);
  const nowMinute = Math.floor(now.getTime() / 60_000);
  return nowMinute > lastMinute;
}

/**
 * Parse a schedule expression into a CronSchedule.
 *
 * Accepted forms:
 *   - Five-field cron string: "m h dom mon dow", each field a number or "*".
 *     Example: "0 7 * * *" (daily at 07:00).
 *   - Interval: "<n><unit>" where unit is s/m/h/d.
 *     Example: "30m" (every 30 minutes), "6h" (every 6 hours), "1d" (daily).
 *
 * The parser is intentionally minimal and strict: it rejects shapes it does
 * not understand rather than guessing. This is the RC scope decision from
 * ADR-0019 ("simple schedules, either cron strings or interval syntax").
 */
export function parseSchedule(raw: string): CronSchedule {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("Cron schedule is required");
  }

  const intervalMatch = trimmed.match(INTERVAL_PATTERN);
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    if (!Number.isInteger(amount) || amount <= 0 || unit === undefined) {
      throw new Error(`Invalid cron interval: ${raw}`);
    }
    return { raw: trimmed, kind: "interval", describe: () => trimmed };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length === 5 && fields.every((field) => field === "*" || /^\d+$/.test(field))) {
    return { raw: trimmed, kind: "cron", describe: () => trimmed };
  }

  throw new Error(`Invalid cron schedule: ${raw}. Use a five-field cron string or an interval like "30m".`);
}
