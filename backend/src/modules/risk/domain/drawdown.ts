import { Prisma } from '@prisma/client';

/**
 * MODULE 06 - maximum drawdown, the loss a holder actually had to sit through.
 *
 * Drawdown measures the worst decline from a previous high, so it answers a
 * question volatility cannot: not "how much does it move" but "how much was I
 * ever down". A strategy that climbs steadily and then halves is quiet in
 * variance terms for most of its life and catastrophic in drawdown terms, and
 * this is the number that says so.
 *
 * Measured on equity, never on returns: a peak-to-trough *return* is not a loss
 * anyone could have realised, because the peak is only knowable from the other
 * side of the trough.
 *
 * `maxDrawdown([ ])` is exactly 0 - there is no decline to report, which is not
 * the same as a missing figure. Callers are responsible for refusing to report
 * at all when there is too little evidence; this function only has to be well
 * defined for every input it is handed, including the empty one.
 *
 * The peak is tracked rather than recomputed, so a recovery above an earlier
 * high starts a new episode instead of inheriting the old trough:
 * `[100, 80, 120]` has a drawdown of 0.2, not 0.33. A monotonically rising
 * series returns exactly 0 - every step's drawdown is zero, not "small".
 *
 * Returned unrounded and on [0, 1]. Classification reads this value as-is;
 * only the published copy is rounded, and only once.
 */
export function maxDrawdown(equity: readonly Prisma.Decimal[]): Prisma.Decimal {
  let peak: Prisma.Decimal | undefined;
  let worst = new Prisma.Decimal(0);

  for (const value of equity) {
    if (peak === undefined || value.gt(peak)) {
      peak = value;
    }

    const drawdown = peak.minus(value).div(peak);

    if (drawdown.gt(worst)) {
      worst = drawdown;
    }
  }

  return worst;
}
