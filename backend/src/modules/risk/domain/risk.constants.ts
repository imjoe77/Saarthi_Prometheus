import { Prisma } from '@prisma/client';

/**
 * MODULE 06 - the Risk Engine's published policy.
 *
 * Every value here is a property of the *measurement*, not of any particular
 * strategy: how much evidence a risk statement needs, where one classification
 * becomes the next, and how a dimensionless ratio is turned into something a
 * screen can render.
 *
 * Nothing in this file is stored, so a threshold cannot go stale in a row and
 * changing one is a code change with a test rather than a data migration. That
 * is deliberate: an old threshold still attached to a strategy would be an
 * unreadable classification nobody could reproduce.
 */

/**
 * Observations required before any risk figure is reported.
 *
 * Thirty daily points is the smallest window over which a dispersion estimate
 * says anything at all. It counts observations rather than calendar days
 * because the series contract promises one observation per UTC day - thirty
 * points *is* thirty days, and a second check would only restate the first.
 */
export const REQUIRED_OBSERVATIONS = 30;

/**
 * How a response describes its own sample, so a client can explain an empty
 * state in words rather than in a number that looks like zero.
 */
export const SAMPLE_DESCRIPTION = 'daily equity points';

/** Decimal places in a published metric. Four renders a percentage and no more. */
export const DISPLAY_PLACES = 4;

/**
 * The square root of 252, the number of trading days in a year.
 *
 * Irrational, so it is written down rather than recomputed. Ten decimal places
 * truncate at a relative error below 1e-10, four orders of magnitude finer than
 * the four decimal places the result is finally rounded to, so the truncation
 * can never move a published figure or flip a classification.
 */
export const SQRT_252 = new Prisma.Decimal('15.8745078664');

/** Maximum drawdown at or above which a strategy is classified HIGH. */
export const DRAWDOWN_HIGH = new Prisma.Decimal('0.10');

/** Maximum drawdown at or above which a strategy is classified MEDIUM. */
export const DRAWDOWN_MEDIUM = new Prisma.Decimal('0.05');

/** Annualised volatility at or above which a strategy is classified HIGH. */
export const ANNUALISED_VOLATILITY_HIGH = new Prisma.Decimal('0.40');

/** Annualised volatility at or above which a strategy is classified MEDIUM. */
export const ANNUALISED_VOLATILITY_MEDIUM = new Prisma.Decimal('0.20');

/**
 * The one place a dimensionless ratio becomes a number a client can render.
 *
 * Rounding happens once, at the output boundary, and never before a threshold
 * comparison: a drawdown of 0.0999999 rounds to 0.1 for display and is still
 * not HIGH, because the classification read the unrounded value. Half-up rather
 * than half-even, because a published percentage is read by people and 0.00005
 * should not disappear to 0.
 */
export function toDisplayNumber(value: Prisma.Decimal): number {
  return value.toDecimalPlaces(DISPLAY_PLACES, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}
