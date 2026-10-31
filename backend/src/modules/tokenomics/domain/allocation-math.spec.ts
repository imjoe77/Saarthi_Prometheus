import { ERROR_CODES } from '../../../common/constants/error-codes';
import { DomainException } from '../../../common/errors/domain.exception';
import {
  computeAllocation,
  emberQuantity,
  parseEmberAmount,
  parseEmberPrice,
  parseReferenceAmount,
  splitReferenceAmount,
} from './allocation-math';

/** Calls `fn`, requires it to refuse with a DomainException, and returns that refusal. */
function refusal(fn: () => unknown): DomainException {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainException) return error;
    throw error;
  }
  throw new Error('expected the call to be refused with a DomainException');
}

/**
 * The rounding policy itself, tested against worked examples.
 *
 * Nothing else in Module 11 does arithmetic: `computeAllocation` is the one
 * path the preview endpoint and `POST /allocations` share, and burn
 * quantities reuse `emberQuantity`. So the invariants proved here - the exact
 * 60/40 example, the exact sum, the floor, the input refusals - are the same
 * ones the API and its e2e tests depend on.
 */
describe('allocation-math', () => {
  describe('the worked 60/40 example', () => {
    it('splits ₹80,000 at a ₹10 price into the documented figures', () => {
      const result = computeAllocation('80000', '10', 60, 40);

      expect(result.directBurnInr.toString()).toBe('48000');
      expect(result.buybackInr.toString()).toBe('32000');
      expect(result.directBurnEmber.toString()).toBe('4800');
      expect(result.buybackEmber.toString()).toBe('3200');
    });

    it('keeps both portions positive and additive for an odd amount', () => {
      const result = computeAllocation('100.01', '1', 60, 40);

      // 100.01 x 60% = 60.006 -> HALF_UP to 60.01; the buyback is the exact
      // remainder 40.00, not a second rounded 60.006-style product.
      expect(result.directBurnInr.toString()).toBe('60.01');
      expect(result.buybackInr.toString()).toBe('40');
      expect(result.directBurnInr.plus(result.buybackInr).toString()).toBe('100.01');
      expect(result.directBurnEmber.toString()).toBe('60.01');
      expect(result.buybackEmber.toString()).toBe('40');
    });

    it('sums to the reference amount exactly at every tested scale', () => {
      for (const reference of ['0.01', '1', '100.01', '80000', '999999999999999999.99']) {
        const { directBurnInr, buybackInr } = splitReferenceAmount(
          parseReferenceAmount(reference),
          60,
          40,
        );

        expect(directBurnInr.plus(buybackInr).toString()).toBe(reference);
        expect(directBurnInr.decimalPlaces()).toBeLessThanOrEqual(2);
        expect(buybackInr.decimalPlaces()).toBeLessThanOrEqual(2);
      }
    });
  });

  describe('a configurable split', () => {
    it('applies a 70/30 configuration instead of the default', () => {
      const result = computeAllocation('80000', '10', 70, 30);

      expect(result.directBurnInr.toString()).toBe('56000');
      expect(result.buybackInr.toString()).toBe('24000');
      expect(result.directBurnEmber.toString()).toBe('5600');
      expect(result.buybackEmber.toString()).toBe('2400');
    });

    it('applies an 80/20 configuration', () => {
      const result = computeAllocation('10000', '5', 80, 20);

      expect(result.directBurnInr.toString()).toBe('8000');
      expect(result.buybackInr.toString()).toBe('2000');
      expect(result.directBurnEmber.toString()).toBe('1600');
      expect(result.buybackEmber.toString()).toBe('400');
    });

    it('refuses percentages that do not sum to 100', () => {
      expect(refusal(() => splitReferenceAmount(parseReferenceAmount('100'), 60, 39)).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
      expect(refusal(() => splitReferenceAmount(parseReferenceAmount('100'), 0, 0)).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
    });

    it('refuses fractional or negative percentages', () => {
      expect(
        refusal(() => splitReferenceAmount(parseReferenceAmount('100'), 60.5, 39.5)).code,
      ).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(
        refusal(() => splitReferenceAmount(parseReferenceAmount('100'), -60, 160)).code,
      ).toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  });

  describe('quantities at different prices', () => {
    it('derives different quantities for the same split at different prices', () => {
      const atTen = computeAllocation('80000', '10', 60, 40);
      const atEight = computeAllocation('80000', '8', 60, 40);

      expect(atTen.directBurnEmber.toString()).toBe('4800');
      expect(atEight.directBurnEmber.toString()).toBe('6000');
      expect(atTen.buybackEmber.toString()).toBe('3200');
      expect(atEight.buybackEmber.toString()).toBe('4000');
    });

    it('accepts a fractional price up to 18dp', () => {
      const result = computeAllocation('100', '10.5', 60, 40);

      expect(result.directBurnInr.toString()).toBe('60');
      expect(result.buybackInr.toString()).toBe('40');
      // 60 / 10.5 = 5.714285714285714285... floored to 18dp.
      expect(result.directBurnEmber.toString()).toBe('5.714285714285714285');
      // 40 / 10.5 = 3.809523809523809523... floored to 18dp.
      expect(result.buybackEmber.toString()).toBe('3.809523809523809523');
    });

    it('floors a long repeating quotient with 60-digit division precision', () => {
      // 400000000000000000 / 7 needs a 17-digit integer part plus an 18dp
      // fraction - 35 significant digits, well beyond decimal.js's default
      // 20. At the default the quotient is rounded at the 20th digit and the
      // floor would claim .86 EMBER the portion cannot fund instead of
      // .857142857142857142.
      const portion = parseReferenceAmount('400000000000000000.00');
      const price = parseEmberPrice('7');

      expect(emberQuantity(portion, price).toString()).toBe(
        '57142857142857142.857142857142857142',
      );
    });

    it('never lets the quantity exceed what its portion funds at that price', () => {
      const result = computeAllocation('0.03', '7', 60, 40);

      const funded = result.directBurnEmber.times(result.emberPrice);
      expect(funded.lte(result.directBurnInr)).toBe(true);
      expect(result.directBurnEmber.decimalPlaces()).toBeLessThanOrEqual(18);
    });
  });

  describe('input validation', () => {
    it('refuses a zero or negative reference amount', () => {
      expect(refusal(() => parseReferenceAmount('0')).code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(refusal(() => parseReferenceAmount('-1')).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('refuses a reference amount beyond INR 2dp rather than rounding it', () => {
      expect(refusal(() => parseReferenceAmount('10.005')).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
      expect(refusal(() => parseReferenceAmount('10.001')).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
    });

    it('refuses a zero or negative price', () => {
      expect(refusal(() => parseEmberPrice('0')).code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(refusal(() => parseEmberPrice('-10')).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('refuses a zero or negative EMBER burn amount at 18dp', () => {
      expect(refusal(() => parseEmberAmount('0')).code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(refusal(() => parseEmberAmount('-5')).code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(refusal(() => parseEmberAmount('1.0000000000000000001')).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
    });

    it('refuses a non-numeric string before any computation', () => {
      expect(refusal(() => computeAllocation('eighty thousand', '10', 60, 40)).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
      expect(refusal(() => computeAllocation('80000', 'ten', 60, 40)).code).toBe(
        ERROR_CODES.VALIDATION_FAILED,
      );
    });
  });

  describe('computation shape', () => {
    it('echoes the validated inputs and the split it was given', () => {
      const result = computeAllocation('80000', '10.25', 60, 40);

      expect(result.referenceAmount.toString()).toBe('80000');
      expect(result.emberPrice.toString()).toBe('10.25');
      expect(result.directBurnPct).toBe(60);
      expect(result.buybackPct).toBe(40);
    });

    it('is deterministic: the same inputs always produce the same figures', () => {
      const first = computeAllocation('12345.67', '3.33', 60, 40);
      const second = computeAllocation('12345.67', '3.33', 60, 40);

      expect(first.directBurnInr.toString()).toBe(second.directBurnInr.toString());
      expect(first.buybackInr.toString()).toBe(second.buybackInr.toString());
      expect(first.directBurnEmber.toString()).toBe(second.directBurnEmber.toString());
      expect(first.buybackEmber.toString()).toBe(second.buybackEmber.toString());
    });
  });
});
