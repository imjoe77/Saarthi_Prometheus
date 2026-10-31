import { Prisma } from '@prisma/client';

import { computeReturns, isFlat, validateSeries, type EquityPoint } from './series';

/**
 * MODULE 06 - the input contract, and the reason a bad series becomes
 * `INVALID_SERIES` instead of a repaired one.
 *
 * Each rejection is isolated to a single rule, so `ok: false` is unambiguous:
 * the duplicate-date case has positive equity and consecutive positions, the
 * gap case has unique ascending dates, and so on. If a case could fail two
 * rules at once the assertion would not prove which one fired.
 */
describe('series contract', () => {
  function days(startIso: string, count: number): string[] {
    const dates: string[] = [];
    let day = Date.parse(`${startIso}T00:00:00.000Z`);

    for (let index = 0; index < count; index += 1) {
      dates.push(new Date(day).toISOString().slice(0, 10));
      day += 86_400_000;
    }

    return dates;
  }

  function decimals(...values: string[]): Prisma.Decimal[] {
    return values.map((value) => new Prisma.Decimal(value));
  }

  function series(startIso: string, equities: string[]): EquityPoint[] {
    const dates = days(startIso, equities.length);

    return equities.map((equity, index) => ({
      observedAt: dates[index] ?? startIso,
      equity,
    }));
  }

  describe('acceptance', () => {
    it('accepts an empty series, reporting no dates rather than inventing them', () => {
      const result = validateSeries([]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.equity).toEqual([]);
        expect(result.firstObservedAt).toBeNull();
        expect(result.lastObservedAt).toBeNull();
      }
    });

    it('accepts a single observation', () => {
      const result = validateSeries([{ observedAt: '2026-10-07', equity: '100' }]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.equity).toHaveLength(1);
        expect(result.firstObservedAt).toBe('2026-10-07');
        expect(result.lastObservedAt).toBe('2026-10-07');
      }
    });

    it('parses equity without losing precision, so a measurement is never pre-rounded', () => {
      const result = validateSeries(
        series('2026-10-01', ['100.000000000000000001', '100.000000000000000002']),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.equity[0]?.toFixed()).toBe('100.000000000000000001');
        expect(result.equity[1]?.minus(result.equity[0] as Prisma.Decimal).toFixed()).toBe(
          '0.000000000000000001',
        );
      }
    });

    it('accepts a year boundary and a leap day, which are ordinary one-day steps', () => {
      const yearEnd = validateSeries(
        ['2027-12-31', '2028-01-01'].map((observedAt) => ({ observedAt, equity: '100' })),
      );
      const leapDay = validateSeries(
        ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'].map((observedAt) => ({
          observedAt,
          equity: '100',
        })),
      );

      expect(yearEnd.ok).toBe(true);
      expect(leapDay.ok).toBe(true);
    });

    it('reports the first and last dates of the observations it accepted', () => {
      const result = validateSeries(series('2026-10-01', ['100', '101', '102']));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.firstObservedAt).toBe('2026-10-01');
        expect(result.lastObservedAt).toBe('2026-10-03');
      }
    });
  });

  describe('rejection', () => {
    it('rejects non-positive equity, which has no ratio to its predecessor', () => {
      expect(validateSeries([{ observedAt: '2026-10-01', equity: '0' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2026-10-01', equity: '-42' }]).ok).toBe(false);
    });

    it('rejects equity that is not a number at all', () => {
      expect(validateSeries([{ observedAt: '2026-10-01', equity: 'abc' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2026-10-01', equity: '   ' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2026-10-01', equity: 'Infinity' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2026-10-01', equity: 'NaN' }]).ok).toBe(false);
    });

    it('rejects malformed dates rather than guessing at them', () => {
      expect(validateSeries([{ observedAt: '07/10/2026', equity: '100' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2026-10-07T00:00:00Z', equity: '100' }]).ok).toBe(
        false,
      );
      expect(validateSeries([{ observedAt: '2026-13-01', equity: '100' }]).ok).toBe(false);
    });

    it('rejects a calendar date that does not exist', () => {
      expect(validateSeries([{ observedAt: '2026-02-30', equity: '100' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2026-02-29', equity: '100' }]).ok).toBe(false);
      expect(validateSeries([{ observedAt: '2027-02-29', equity: '100' }]).ok).toBe(false);
    });

    it('rejects the same day recorded twice', () => {
      const result = validateSeries([
        { observedAt: '2026-10-01', equity: '100' },
        { observedAt: '2026-10-01', equity: '101' },
      ]);

      expect(result.ok).toBe(false);
    });

    it('rejects observations in an order that is not ascending', () => {
      const result = validateSeries([
        { observedAt: '2026-10-02', equity: '100' },
        { observedAt: '2026-10-01', equity: '101' },
      ]);

      expect(result.ok).toBe(false);
    });

    it('rejects a missing day, because the observation was never made', () => {
      const result = validateSeries([
        { observedAt: '2026-10-01', equity: '100' },
        { observedAt: '2026-10-03', equity: '102' },
      ]);

      expect(result.ok).toBe(false);
    });

    it('rejects a series where the only problem is one later point', () => {
      const result = validateSeries(
        series('2026-10-01', ['100', '101', '102']).concat([
          { observedAt: '2026-10-10', equity: '103' },
        ]),
      );

      expect(result.ok).toBe(false);
    });
  });

  describe('returns', () => {
    it('produces exactly n - 1 simple returns', () => {
      const returns = computeReturns(decimals('100', '110', '99'));

      expect(returns).toHaveLength(2);
      expect(returns[0]?.toFixed()).toBe('0.1');
      expect(returns[1]?.toFixed()).toBe('-0.1');
    });

    it('produces nothing from zero or one observation', () => {
      expect(computeReturns([])).toEqual([]);
      expect(computeReturns(decimals('100'))).toEqual([]);
    });

    it('does not compound: each return is measured against its own predecessor', () => {
      const returns = computeReturns(decimals('100', '90', '99'));

      // If compounded, the second return would be measured against 100 and read
      // -0.01; measured against its predecessor it is +0.1.
      expect(returns[1]?.toFixed()).toBe('0.1');
    });
  });

  describe('flatness', () => {
    it('detects a series that never moved', () => {
      expect(isFlat(decimals('100', '100', '100'))).toBe(true);
    });

    it('does not mistake a move away from the start for a flat series', () => {
      expect(isFlat(decimals('100', '101', '101'))).toBe(false);
    });

    it('is false for an empty series, which already has its own reason', () => {
      expect(isFlat([])).toBe(false);
    });
  });
});
