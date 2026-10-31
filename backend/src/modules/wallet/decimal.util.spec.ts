import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { formatDecimal, normaliseAmount } from './decimal.util';

/**
 * MODULE 03 - decimal handling.
 *
 * These are pure functions, so the tests are exhaustive rather than illustrative:
 * every rejection rule and every accepted shape. Money that is off by a fraction
 * of a cent is a correctness bug, not a rounding preference, and this is the one
 * place where that can be pinned down cheaply.
 */
const INR = { symbol: 'INR', decimals: 2 };
const USDT = { symbol: 'USDT', decimals: 6 };
const EMBER = { symbol: 'EMBER', decimals: 18 };

function expectValidationFailure(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainException);
    const domainError = error as DomainException;
    expect(domainError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // The code travels to the client, so it is part of the contract.
    expect(domainError.getResponse()).toMatchObject({ code: 'VALIDATION_FAILED' });
    return;
  }

  throw new Error('Expected the amount to be rejected, but it was accepted.');
}

describe('normaliseAmount', () => {
  describe('accepted amounts', () => {
    it('parses an integer string', () => {
      expect(normaliseAmount('100', USDT).toString()).toBe('100');
    });

    it('parses a value with exactly the asset scale', () => {
      expect(normaliseAmount('100.50', INR).toString()).toBe('100.5');
    });

    it('trims surrounding whitespace', () => {
      expect(normaliseAmount('  42.25  ', INR).toString()).toBe('42.25');
    });

    it('accepts the smallest unit at the asset scale', () => {
      expect(normaliseAmount('0.01', INR).toString()).toBe('0.01');
    });

    it('accepts 18 decimals for EMBER', () => {
      const smallest = '0.000000000000000001';
      const parsed = normaliseAmount(smallest, EMBER);

      // toString() would be "1e-18"; the value and the rendered string are what
      // matter, which is precisely why reads go through formatDecimal.
      expect(parsed.equals(new Prisma.Decimal(smallest))).toBe(true);
      expect(formatDecimal(parsed, EMBER.decimals)).toBe(smallest);
    });

    it('accepts an already-parsed Decimal without re-parsing', () => {
      const input = new Prisma.Decimal('7.125');
      expect(normaliseAmount(input, USDT)).toBe(input);
    });
  });

  describe('rejected amounts', () => {
    it('rejects an empty string', () => {
      expectValidationFailure(() => normaliseAmount('', INR));
    });

    it('rejects a whitespace-only string', () => {
      expectValidationFailure(() => normaliseAmount('   ', INR));
    });

    it('rejects a non-numeric string', () => {
      expectValidationFailure(() => normaliseAmount('abc', INR));
    });

    it('rejects NaN', () => {
      expectValidationFailure(() => normaliseAmount('NaN', INR));
    });

    it.each(['Infinity', '-Infinity'])('rejects %s', (value) => {
      expectValidationFailure(() => normaliseAmount(value, INR));
    });

    it.each(['0', '0.00'])('rejects zero (%s)', (value) => {
      expectValidationFailure(() => normaliseAmount(value, INR));
    });

    it('rejects a negative amount', () => {
      expectValidationFailure(() => normaliseAmount('-1', INR));
    });

    it('rejects more decimal places than the asset allows', () => {
      expectValidationFailure(() => normaliseAmount('1.234', INR));
    });

    it('rejects one place beyond the asset scale even when otherwise valid', () => {
      expectValidationFailure(() => normaliseAmount('0.0000001', USDT));
    });
  });
});

describe('formatDecimal', () => {
  it('pads an integer to the asset scale', () => {
    expect(formatDecimal(new Prisma.Decimal('1'), INR.decimals)).toBe('1.00');
  });

  it('pads a partial value to the asset scale', () => {
    expect(formatDecimal(new Prisma.Decimal('1.5'), USDT.decimals)).toBe('1.500000');
  });

  it('renders zero at full scale', () => {
    expect(formatDecimal(new Prisma.Decimal('0'), EMBER.decimals)).toBe('0.000000000000000000');
  });

  it('never uses exponential notation for a very small value', () => {
    const smallest = new Prisma.Decimal('0.000000000000000001');
    expect(formatDecimal(smallest, EMBER.decimals)).toBe('0.000000000000000001');
  });

  it('renders a large value without separators', () => {
    expect(formatDecimal(new Prisma.Decimal('1000000'), USDT.decimals)).toBe('1000000.000000');
  });
});
