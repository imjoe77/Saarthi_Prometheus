import { Prisma } from '@prisma/client';

/**
 * MODULE 06 - the input contract for every risk measurement, and the one place
 * it is enforced.
 *
 * THE RISK ENGINE IS READ-ONLY AND A CONSUMER. It does not produce equity
 * points (no Module 06b exists yet), so it describes what a producer must hand
 * it rather than promising anything about how points are recorded. The contract
 * is what makes the measurements reproducible: a series that violates it cannot
 * be aggregated with the same meaning as one that does not.
 *
 * A DAY IS THE UNIT OF OBSERVATION. Risk is measured over trading sessions, not
 * over wall-clock distance, so an observation is a UTC calendar day. `2026-10-07`
 * is the whole day; the hours inside it are not part of this module's model.
 */

/** One observation: a UTC calendar day and the strategy equity quoted on it. */
export interface EquityPoint {
  /** ISO-8601 UTC date, `YYYY-MM-DD`. */
  readonly observedAt: string;
  /** Equity as a decimal string, strictly positive, in one base unit. */
  readonly equity: string;
}

/** The outcome of validating a series against the contract. */
export type SeriesValidation =
  | {
      readonly ok: true;
      /** Observations parsed as decimals, in ascending date order. */
      readonly equity: readonly Prisma.Decimal[];
      readonly firstObservedAt: string | null;
      readonly lastObservedAt: string | null;
    }
  | { readonly ok: false };

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MILLISECONDS = 86_400_000;

/**
 * An ISO date reduced to a day number, or null if it is not one.
 *
 * Nonexistent calendar dates are rejected by the round-trip rather than by a
 * calendar table: `2026-02-30` either fails to parse or lands in March, and in
 * both cases the canonical re-render of the instant differs from the input.
 * That keeps this function free of month-length and leap-year arithmetic while
 * still refusing a date nobody can plot.
 */
function asUtcDay(observedAt: string): number | null {
  if (!UTC_DAY_PATTERN.test(observedAt)) {
    return null;
  }

  const epoch = Date.parse(`${observedAt}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) {
    return null;
  }

  if (new Date(epoch).toISOString().slice(0, 10) !== observedAt) {
    return null;
  }

  return epoch / DAY_IN_MILLISECONDS;
}

/**
 * Parse and check a series, returning it as decimals when it satisfies every
 * part of the contract and `ok: false` when it does not.
 *
 * Rejection is all-or-nothing on purpose. A series with one impossible date or
 * one missing day describes a different history than the one it claims, and
 * repairing it here would mean inventing the missing observation - fabricating
 * evidence in the module whose whole job is to refuse to do so. A bad series
 * becomes `INVALID_SERIES`, not a best-effort answer.
 */
export function validateSeries(points: readonly EquityPoint[]): SeriesValidation {
  const equity: Prisma.Decimal[] = [];
  let previousDay: number | null = null;
  let firstObservedAt: string | null = null;
  let lastObservedAt: string | null = null;

  for (const point of points) {
    const day = asUtcDay(point.observedAt);
    if (day === null) {
      return { ok: false };
    }

    if (previousDay !== null) {
      const distance = day - previousDay;
      // Non-positive means the same day twice or backwards; anything but one
      // means a day nobody recorded. Both are a different history.
      if (distance < 1) {
        return { ok: false };
      }
      if (distance > 1) {
        return { ok: false };
      }
    }

    const value = parseEquity(point.equity);
    if (value === null) {
      return { ok: false };
    }

    equity.push(value);
    firstObservedAt ??= point.observedAt;
    lastObservedAt = point.observedAt;
    previousDay = day;
  }

  return { ok: true, equity, firstObservedAt, lastObservedAt };
}

/**
 * One equity value as a positive, finite decimal, or null when it is none of
 * those.
 *
 * `lte(0)` is the substantive rule: equity is a quantity of value, and a zero or
 * negative balance has no ratio to its predecessor - `(0 - 1) / 0` is not a
 * return, it is a division by zero dressed as one. NaN and infinity are rejected
 * for the same reason, since `isFinite` precedes any arithmetic done on them.
 */
function parseEquity(raw: string): Prisma.Decimal | null {
  if (raw.trim() === '') {
    return null;
  }

  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(raw);
  } catch {
    return null;
  }

  if (!value.isFinite() || value.lte(0)) {
    return null;
  }

  return value;
}

/**
 * Simple returns `r_t = (E_t - E_{t-1}) / E_{t-1}` for `n` observations, giving
 * exactly `n - 1` values.
 *
 * Never compounded and never log-returns: the first is what the equity curve
 * actually did between two days, the second would assume returns are
 * continuously compounded when nothing here compounds at all. The sample size
 * the volatility estimator divides by follows from this choice.
 */
export function computeReturns(equity: readonly Prisma.Decimal[]): Prisma.Decimal[] {
  const returns: Prisma.Decimal[] = [];

  for (let index = 1; index < equity.length; index += 1) {
    const previous = equity[index - 1];
    const current = equity[index];

    if (previous && current) {
      returns.push(current.minus(previous).div(previous));
    }
  }

  return returns;
}

/**
 * Whether every observation equals the first.
 *
 * The test for "nothing happened": a series whose equity never moved has no
 * dispersion, so its standard deviation is exactly zero - a figure indistinguishable
 * from a strategy that genuinely had zero volatility. Flat series are reported as
 * `NO_ACTIVITY` rather than evaluated, so zero volatility in a response always
 * means a real, if constant, movement.
 *
 * False for an empty series, which already has its own reason.
 */
export function isFlat(equity: readonly Prisma.Decimal[]): boolean {
  const first = equity[0];
  if (first === undefined) {
    return false;
  }

  return equity.every((value) => value.equals(first));
}
