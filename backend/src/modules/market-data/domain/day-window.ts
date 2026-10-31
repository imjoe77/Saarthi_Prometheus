/**
 * MODULE 06b - calendar arithmetic on UTC days, in one place.
 *
 * WHY A DAY NUMBER AND NOT `Date`. Every date in this module is a whole UTC day
 * with no time component, and the only operations needed are "is this the next
 * day", "which days are missing between these two" and "how many days is this
 * window". Doing those with `Date` means month-length and leap-year arithmetic
 * spread across the importer and the engine. Reducing a day to an integer count
 * of days since the epoch turns all three into integer arithmetic, and the
 * conversion is a single round-trip that rejects anything that is not a real
 * calendar date.
 *
 * Every function here is pure and total: an unparseable date yields `null` (or a
 * list containing it, for the gap finder) rather than an exception, because the
 * importer's contract is to report findings, not to throw at them.
 */
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MILLISECONDS = 86_400_000;

/**
 * An ISO date reduced to a day number, or null if it is not one.
 *
 * Nonexistent calendar dates are rejected by the round-trip rather than by a
 * month table: `2026-02-30` either fails to parse or lands on 1 March, and in
 * both cases re-rendering the instant gives a different string from the input.
 */
export function toDayNumber(day: string): number | null {
  if (!UTC_DAY_PATTERN.test(day)) {
    return null;
  }

  const epoch = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) {
    return null;
  }

  if (new Date(epoch).toISOString().slice(0, 10) !== day) {
    return null;
  }

  return epoch / DAY_IN_MILLISECONDS;
}

export function fromDayNumber(dayNumber: number): string {
  return new Date(dayNumber * DAY_IN_MILLISECONDS).toISOString().slice(0, 10);
}

/** Every day from `start` to `end` inclusive, ascending. Empty if either end is invalid. */
export function listDaysBetween(start: string, end: string): string[] {
  const from = toDayNumber(start);
  const to = toDayNumber(end);
  if (from === null || to === null || to < from) {
    return [];
  }

  const days: string[] = [];
  for (let day = from; day <= to; day += 1) {
    days.push(fromDayNumber(day));
  }
  return days;
}

/**
 * Days absent from `days`, between its own first and last entry, ascending.
 *
 * Days outside the observed window are not "missing" - nothing claimed they
 * existed. Duplicates and out-of-order input are tolerated here and checked by
 * the caller, so this function answers exactly one question: of the days that
 * were expected, which never arrived?
 */
export function findMissingDays(days: readonly string[]): string[] {
  if (days.length < 2) {
    return [];
  }

  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    return [];
  }

  const from = toDayNumber(first);
  const to = toDayNumber(last);
  if (from === null || to === null) {
    return [];
  }

  const present = new Set<number>();
  for (const day of days) {
    const dayNumber = toDayNumber(day);
    if (dayNumber !== null) {
      present.add(dayNumber);
    }
  }

  const missing: string[] = [];
  for (let day = from; day <= to; day += 1) {
    if (!present.has(day)) {
      missing.push(fromDayNumber(day));
    }
  }
  return missing;
}

/**
 * The `YYYY-MM-DD` a `@db.Date` column holds, read back from Prisma.
 *
 * One helper because there is exactly one convention in this module - a date is
 * always the UTC calendar day - and duplicating the slicing at a dozen call
 * sites is how two conventions start to disagree about a boundary.
 */
export function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The `YYYY-MM-DD` a `@db.Date` column should hold, written as a UTC midnight `Date`. */
export function fromIsoDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
