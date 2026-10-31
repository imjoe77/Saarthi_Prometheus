import { Prisma } from '@prisma/client';

import { evaluateThreshold } from './threshold';

/**
 * MODULE 14 - the pure financial comparison, on exact decimals.
 *
 * These are the two direction tests plus the equality edge cases where a
 * binary float would embarrass Sentinel: decimal values that floats cannot
 * represent exactly (`0.1`, `0.3`, long crypto-like fractions) and values that
 * differ only in trailing zeros. A comparison that passed these on floats
 * would occasionally trigger - or miss - an alert on a rounding artefact.
 */
describe('sentinel threshold evaluation', () => {
  describe('GREATER_THAN_OR_EQUAL', () => {
    it('triggers when the observed price equals the target', () => {
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '85', '85')).toBe(true);
    });

    it('triggers when the observed price is above the target', () => {
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '85', '85.20')).toBe(true);
    });

    it('does not trigger below the target', () => {
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '85', '84.99999')).toBe(false);
    });

    it('treats equal-by-value, different-by-notation prices as equal', () => {
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '85.20', '85.2')).toBe(true);
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '85.2000', '85.2')).toBe(true);
    });
  });

  describe('LESS_THAN_OR_EQUAL', () => {
    it('triggers when the observed price equals the target', () => {
      expect(evaluateThreshold('LESS_THAN_OR_EQUAL', '85', '85')).toBe(true);
    });

    it('triggers when the observed price is below the target', () => {
      expect(evaluateThreshold('LESS_THAN_OR_EQUAL', '85.20', '85.1')).toBe(true);
    });

    it('does not trigger above the target', () => {
      expect(evaluateThreshold('LESS_THAN_OR_EQUAL', '85.20', '85.21')).toBe(false);
    });
  });

  describe('decimal exactness', () => {
    it('compares 0.1 exactly, where a float would not', () => {
      // A float comparison of these would fail an equality-based rule.
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '0.1', '0.1')).toBe(true);
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', '0.10', '0.1')).toBe(true);
      expect(evaluateThreshold('LESS_THAN_OR_EQUAL', '0.1', '0.0999999999')).toBe(true);
    });

    it('keeps precision on crypto-scale fractions', () => {
      const target = new Prisma.Decimal('97123.4567891');
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', target, '97123.4567892')).toBe(true);
      expect(evaluateThreshold('GREATER_THAN_OR_EQUAL', target, '97123.45678901')).toBe(false);
    });

    it('accepts a mix of Decimal and string inputs', () => {
      expect(
        evaluateThreshold('GREATER_THAN_OR_EQUAL', new Prisma.Decimal('100'), '100.000000'),
      ).toBe(true);
      expect(
        evaluateThreshold('GREATER_THAN_OR_EQUAL', '100', new Prisma.Decimal('99.9999999999')),
      ).toBe(false);
    });

    it('handles large fiat-scale magnitudes exactly', () => {
      expect(
        evaluateThreshold('GREATER_THAN_OR_EQUAL', '1000000000.000000000000000001', '1000000000.000000000000000002'),
      ).toBe(true);
    });
  });
});
