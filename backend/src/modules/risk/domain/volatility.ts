import { Prisma } from '@prisma/client';

import { SQRT_252 } from './risk.constants';

/**
 * MODULE 06 - dispersion of daily returns, and its annualisation.
 *
 * Volatility here is the standard deviation of *simple daily returns*, which is
 * the shape the equity series actually has. It is an estimate from a sample,
 * not a property of an infinite population, and every divisor below follows
 * from that.
 *
 * WHY THE SAMPLE DIVISOR (n - 2) AND NOT THE POPULATION ONE (n - 1). The
 * returns are computed from the observations, so they are not free: the first
 * return is pinned by the first observation, and once the mean of the returns
 * is estimated as well, two degrees of freedom are spent. Dividing by
 * `returns.length - 1` - equivalently `observations - 2` - is what keeps the
 * estimate unbiased for this construction. Substituting the population divisor
 * because it is the more familiar formula would quietly understate the spread
 * of every strategy, and at thirty observations the gap between the two
 * divisors is close to the gap between two adjacent thresholds.
 */

/**
 * Sample standard deviation of daily returns.
 *
 * Returns a plain `0` for a series whose returns are all identical - not a
 * missing value. `RiskService` rejects flat series before reaching this
 * function, so a published zero always means genuinely constant movement
 * rather than an absent measurement.
 *
 * @throws RangeError when fewer than two returns are supplied, which is
 * unreachable through `RiskService`: any series that could produce a single
 * return is already `INSUFFICIENT_HISTORY`. Thrown rather than defaulted to
 * zero because zero is a measurement, and an under-determined input must never
 * be able to produce one.
 */
export function dailyVolatility(returns: readonly Prisma.Decimal[]): Prisma.Decimal {
  if (returns.length < 2) {
    throw new RangeError('dailyVolatility requires at least two returns');
  }

  const mean = returns
    .reduce((total, value) => total.plus(value), new Prisma.Decimal(0))
    .div(returns.length);

  const squaredDeviations = returns.reduce(
    (total, value) => total.plus(value.minus(mean).pow(2)),
    new Prisma.Decimal(0),
  );

  const variance = squaredDeviations.div(returns.length - 1);

  // The only square root in the module. decimal.js has none, so the variance
  // - a dimensionless ratio, unlike equity or money - crosses to a number for
  // the root and straight back into a Decimal. Nothing is rounded on the way:
  // Math.sqrt is exact to double precision, far finer than the four decimal
  // places the result is finally published at.
  return new Prisma.Decimal(Math.sqrt(variance.toNumber()));
}

/**
 * Daily volatility scaled to a year.
 *
 * The √252 factor is multiplication by a constant, never a re-fit: 252 is the
 * usual number of trading sessions in a year, held as a fixed literal so the
 * same series cannot produce different annualised figures in different runs.
 *
 * Scaling this way assumes sessions are independent. That is a convention, not
 * a claim about markets, and it is what makes the figure comparable across
 * strategies - which, by the series contract, all observe on the same cadence.
 */
export function annualisedVolatility(dailyVolatility: Prisma.Decimal): Prisma.Decimal {
  return dailyVolatility.times(SQRT_252);
}
