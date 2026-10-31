import { Prisma } from '@prisma/client';

import { decimalString } from './decimal-string';

/**
 * MODULE 06b - the shortest exact decimal rendering.
 *
 * The whole point of the helper is that the number of decimal places is a
 * property of the *value* (trailing zeros are not part of it), so the assertion
 * every other test leans on - "a value stored as `94591.780000000000000000`
 * comes back as `94591.78`" - lives here once.
 */
describe('decimalString', () => {
  it('renders a price without the column-scale padding', () => {
    expect(decimalString(new Prisma.Decimal('94591.780000000000000000'))).toBe('94591.78');
  });

  it('keeps every digit a small dust balance actually has', () => {
    expect(decimalString(new Prisma.Decimal('0.0004180393218'))).toBe('0.0004180393218');
  });

  it('renders a value below the exponential threshold in fixed point', () => {
    expect(decimalString(new Prisma.Decimal('1e-9'))).toBe('0.000000001');
  });

  it('renders an integral value without a decimal point', () => {
    expect(decimalString(new Prisma.Decimal('100000'))).toBe('100000');
    expect(decimalString(new Prisma.Decimal(0))).toBe('0');
  });

  it('renders a twenty-three-fill gross exactly as stored', () => {
    expect(decimalString(new Prisma.Decimal('99900.099900024'))).toBe('99900.099900024');
  });

  it('never loses information to a float round-trip', () => {
    for (const value of ['94591.780000000000000000', '0.0004180393218', '0.001']) {
      const decimal = new Prisma.Decimal(value);
      expect(new Prisma.Decimal(decimalString(decimal)).equals(decimal)).toBe(true);
    }
  });
});