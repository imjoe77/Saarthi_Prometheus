import { Prisma } from '@prisma/client';

import { classifyRiskLevel } from './risk-level';

/**
 * MODULE 06 - where one classification becomes the next.
 *
 * Every boundary is asserted from both sides, because an off-by-one in a
 * `gte` is invisible until a strategy sits exactly on a published threshold -
 * which is the one place a client can check the code against the documentation.
 *
 * The unrounded case is the important one: a value that *displays* as 0.1 but
 * measures 0.0999999 must not be HIGH, or the level would contradict the
 * numbers printed beside it.
 */
describe('classifyRiskLevel', () => {
  function level(drawdown: string, annualised: string): string {
    return classifyRiskLevel(new Prisma.Decimal(drawdown), new Prisma.Decimal(annualised));
  }

  it('is LOW while both measures sit below their thresholds', () => {
    expect(level('0.0499', '0.1999')).toBe('LOW');
    expect(level('0', '0')).toBe('LOW');
  });

  it('is MEDIUM at a drawdown of 0.05, and HIGH at 0.10', () => {
    expect(level('0.05', '0')).toBe('MEDIUM');
    expect(level('0.04999', '0')).toBe('LOW');
    expect(level('0.10', '0')).toBe('HIGH');
    expect(level('0.0999', '0')).toBe('MEDIUM');
  });

  it('is MEDIUM at an annualised volatility of 0.20, and HIGH at 0.40', () => {
    expect(level('0', '0.20')).toBe('MEDIUM');
    expect(level('0', '0.1999')).toBe('LOW');
    expect(level('0', '0.40')).toBe('HIGH');
    expect(level('0', '0.3999')).toBe('MEDIUM');
  });

  it('lets either measure reach HIGH on its own', () => {
    expect(level('0.10', '0.19')).toBe('HIGH');
    expect(level('0.04', '0.40')).toBe('HIGH');
  });

  it('classifies on the unrounded value, never on the published one', () => {
    // Displays as 0.1, measures 0.0999999. Rounded-first classification would
    // call this HIGH and then print a drawdown that agrees with the wrong
    // answer; unrounded it is MEDIUM on the drawdown alone.
    expect(level('0.0999999', '0.05')).toBe('MEDIUM');
    expect(level('0.1000001', '0')).toBe('HIGH');
  });
});
