import { Prisma } from '@prisma/client';

import { toDisplayNumber } from './risk.constants';
import { annualisedVolatility, dailyVolatility } from './volatility';

/**
 * MODULE 06 - dispersion of daily returns.
 *
 * The constants in these assertions were computed independently of the
 * implementation, so a change to a divisor or to the annualisation factor
 * fails here rather than quietly reclassifying every strategy.
 */
describe('volatility', () => {
  function decimals(...values: string[]): Prisma.Decimal[] {
    return values.map((value) => new Prisma.Decimal(value));
  }

  describe('daily volatility', () => {
    it('matches the reference series', () => {
      // Returns alternate ±0.1: mean 0.02, sum of squared deviations 0.048,
      // sample variance 0.048 / 4 = 0.012, sigma = sqrt(0.012).
      const returns = decimals('0.1', '-0.1', '0.1', '-0.1', '0.1');
      const volatility = dailyVolatility(returns);

      expect(toDisplayNumber(volatility)).toBe(0.1095);
    });

    it('divides by n - 2 observations, not n - 1', () => {
      const returns = decimals('0.1', '-0.1', '0.1', '-0.1', '0.1');
      const sample = dailyVolatility(returns);
      const squared = returns
        .reduce((total, value) => total.plus(value), new Prisma.Decimal(0))
        .div(returns.length);

      // The same five returns with the population divisor give 0.0980. If the
      // estimator used it, both assertions below would move together.
      const population = new Prisma.Decimal(
        Math.sqrt(
          returns
            .reduce(
              (total, value) => total.plus(value.minus(squared).pow(2)),
              new Prisma.Decimal(0),
            )
            .div(returns.length)
            .toNumber(),
        ),
      );

      expect(toDisplayNumber(sample)).toBe(0.1095);
      expect(toDisplayNumber(population)).toBe(0.098);
      expect(sample.equals(population)).toBe(false);
    });

    it('is exactly zero when every return is identical and non-zero', () => {
      // A strategy that climbs by the same amount every session really does
      // have no dispersion - and `isFlat` is what stops a series that never
      // moved at all from being reported this way.
      const returns = decimals('0.1', '0.1', '0.1', '0.1');

      expect(dailyVolatility(returns).isZero()).toBe(true);
      expect(toDisplayNumber(dailyVolatility(returns))).toBe(0);
    });

    it('measures the reference series of thirty alternating returns', () => {
      const returns = [
        ...Array(15).fill(new Prisma.Decimal('0.1')),
        ...Array(15).fill(new Prisma.Decimal('-0.1')),
      ];
      const volatility = dailyVolatility(returns);

      expect(toDisplayNumber(volatility)).toBe(0.1017);
    });

    it('refuses a sample too small to estimate from', () => {
      expect(() => dailyVolatility([])).toThrow(RangeError);
      expect(() => dailyVolatility(decimals('0.1'))).toThrow(RangeError);
    });
  });

  describe('annualised volatility', () => {
    it('scales by the fixed √252 constant rather than recomputing a year', () => {
      expect(toDisplayNumber(annualisedVolatility(new Prisma.Decimal(1)))).toBe(15.8745);
    });

    it('carries the reference series', () => {
      const daily = new Prisma.Decimal('0.10170952554312156579');

      expect(toDisplayNumber(annualisedVolatility(daily))).toBe(1.6146);
    });

    it('is exactly zero when the daily figure is', () => {
      expect(annualisedVolatility(new Prisma.Decimal(0)).isZero()).toBe(true);
    });
  });
});
