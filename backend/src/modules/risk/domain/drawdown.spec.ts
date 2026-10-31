import { Prisma } from '@prisma/client';

import { maxDrawdown } from './drawdown';
import { toDisplayNumber } from './risk.constants';

/**
 * MODULE 06 - the worst decline a holder actually sat through.
 *
 * The fixtures are built by hand rather than generated, so each assertion pins
 * one property: what a trough costs, that a recovery above an earlier high
 * starts a new episode, and that a rising series is exactly zero rather than
 * merely small.
 */
describe('maxDrawdown', () => {
  function decimals(...values: string[]): Prisma.Decimal[] {
    return values.map((value) => new Prisma.Decimal(value));
  }

  it('reports no decline for an empty series', () => {
    expect(maxDrawdown([]).toFixed()).toBe('0');
  });

  it('reports exactly 0 for a series that only ever rose', () => {
    const drawdown = maxDrawdown(decimals('100', '110', '121', '133.1'));

    expect(drawdown.isZero()).toBe(true);
    expect(toDisplayNumber(drawdown)).toBe(0);
  });

  it('measures the trough against the peak that preceded it', () => {
    expect(maxDrawdown(decimals('100', '50', '100')).toFixed()).toBe('0.5');
    expect(maxDrawdown(decimals('100', '80')).toFixed()).toBe('0.2');
  });

  it('measures the trough against the peak that preceded it', () => {
    // 80 is compared with 100, the high before it - not with the 120 that only
    // arrives afterwards, which would read 0.3333 for a decline nobody had yet
    // seen the end of.
    const drawdown = maxDrawdown(decimals('100', '80', '120'));

    expect(drawdown.toFixed()).toBe('0.2');
    expect(toDisplayNumber(drawdown)).toBe(0.2);
  });

  it('keeps the worst episode when several occur', () => {
    const drawdown = maxDrawdown(decimals('100', '95', '105', '70', '110'));

    expect(toDisplayNumber(drawdown)).toBe(0.3333);
  });

  it('reports the worst decline of the reference series', () => {
    const equity = decimals('100', '110', '99', '108.9', '98.01', '107.811');

    expect(maxDrawdown(equity).toFixed()).toBe('0.109');
    expect(toDisplayNumber(maxDrawdown(equity))).toBe(0.109);
  });

  it('rounds half away from zero, once, at the output boundary', () => {
    // Exactly 0.00005 unrounded. Half-up gives 0.0001; half-even would
    // collapse it to 0 and hide a decline that the evidence does contain.
    const drawdown = maxDrawdown(decimals('100000', '99995'));

    expect(drawdown.toFixed()).toBe('0.00005');
    expect(toDisplayNumber(drawdown)).toBe(0.0001);
  });
});
