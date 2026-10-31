import { Prisma } from '@prisma/client';

import { DomainException } from '../../../common/errors/domain.exception';
import {
  MIN_MARKET_ADVANTAGE_INR,
  applyBestPriceGuarantee,
  computeSavings,
  isWithinSanityBand,
  quoteUsdt,
  roundInr,
  settlementAmount,
  venueExecutablePrice,
  walkBookVwap,
  type BookLevel,
  type VenueExecutablePrice,
} from './usdt-pricing';

/**
 * MODULE 08 — the pure pricing rules, tested with no database.
 *
 * The settlement amount and the savings metric decide how much INR a wallet
 * gives up, so each rule is provoked on its own: the order-book VWAP walk
 * (including partial fills and depth), HALF_UP rounding at the paise, the
 * minimum-settlement refusal, the signed savings formula, the sanity band, the
 * derivation of a venue's executable price from its print, and the best-price
 * guarantee that caps or floors the book by those prices. Anything that fails
 * here fails as a wrong balance later.
 */
describe('usdt-pricing (domain)', () => {
  const dec = (value: string) => new Prisma.Decimal(value);
  const level = (price: string, quantity: string): BookLevel => ({ price: dec(price), quantity: dec(quantity) });

  // A believable two-level book: BUY walks asks, SELL walks bids.
  const asks = [level('100.1', '5000'), level('100.2', '5000')];
  const bids = [level('99.9', '5000'), level('99.8', '5000')];

  describe('walkBookVwap', () => {
    it('prices a quantity that fits in the best level at that level', () => {
      const { vwap, sufficient } = walkBookVwap(asks, dec('600'));

      expect(sufficient).toBe(true);
      expect(vwap?.toString()).toBe('100.1');
    });

    it('weights every consumed level by its quantity', () => {
      // (5000 x 100.10 + 5000 x 100.20) / 10000 = 100.15
      const { vwap, sufficient } = walkBookVwap(asks, dec('10000'));

      expect(sufficient).toBe(true);
      expect(vwap?.toString()).toBe('100.15');
    });

    it('walks deeper levels only when the quantity needs them', () => {
      // (5000 x 100.10 + 100 x 100.20) / 5100 = 510520 / 5100
      const { vwap, sufficient } = walkBookVwap(asks, dec('5100'));

      expect(sufficient).toBe(true);
      expect(vwap?.equals(dec('510520').div(dec('5100')))).toBe(true);
    });

    it('reports insufficient depth when the book cannot fill the quantity', () => {
      const { vwap, sufficient } = walkBookVwap(asks, dec('20000'));

      expect(sufficient).toBe(false);
      expect(vwap).toBeNull();
    });

    it('reports insufficient depth for an empty book', () => {
      expect(walkBookVwap([], dec('1'))).toEqual({ vwap: null, sufficient: false });
    });

    it('skips zero-quantity and non-positive levels instead of dividing by them', () => {
      const mixed = [level('100.1', '0'), level('100.3', '-5'), level('100.2', '10')];
      const { vwap, sufficient } = walkBookVwap(mixed, dec('10'));

      expect(sufficient).toBe(true);
      expect(vwap?.toString()).toBe('100.2');
    });

    it('refuses a non-positive quantity rather than pricing it', () => {
      expect(() => walkBookVwap(asks, dec('0'))).toThrow(DomainException);
      expect(() => walkBookVwap(asks, dec('-1'))).toThrow(DomainException);
    });

    it('prices a SELL from the bid side, best bid first', () => {
      const { vwap, sufficient } = walkBookVwap(bids, dec('10000'));

      expect(sufficient).toBe(true);
      expect(vwap?.toString()).toBe('99.85');
    });
  });

  describe('roundInr', () => {
    it('rounds HALF_UP at the paise', () => {
      expect(roundInr(dec('100.005')).toString()).toBe('100.01');
      expect(roundInr(dec('100.004')).toString()).toBe('100');
      expect(roundInr(dec('99.995')).toString()).toBe('100');
    });
  });

  describe('settlementAmount', () => {
    it('converts at the execution price and rounds HALF_UP to two places', () => {
      expect(settlementAmount(dec('10000'), dec('100.15')).toString()).toBe('1001500');
      expect(settlementAmount(dec('1'), dec('100.005')).toString()).toBe('100.01');
      expect(settlementAmount(dec('5100'), dec('510520').div(dec('5100'))).toString()).toBe('510520');
    });

    it('refuses a conversion that rounds below one paise rather than charging dust', () => {
      // 0.000001 USDT at 100 = 0.0001 INR, which rounds to 0.00.
      expect(() => settlementAmount(dec('0.000001'), dec('100'))).toThrow(/minimum/);
      // Just above the floor is accepted: 0.0001 x 99.99 = 0.009999 -> 0.01.
      expect(settlementAmount(dec('0.0001'), dec('99.99')).toString()).toBe('0.01');
    });

    it('refuses a zero or negative amount or price', () => {
      expect(() => settlementAmount(dec('0'), dec('100'))).toThrow(DomainException);
      expect(() => settlementAmount(dec('-1'), dec('100'))).toThrow(DomainException);
      expect(() => settlementAmount(dec('1'), dec('0'))).toThrow(DomainException);
    });

    it('carries a VALIDATION_FAILED code so clients never see an internal error', () => {
      try {
        settlementAmount(dec('0.000001'), dec('100'));
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainException);
        expect((error as DomainException).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('computeSavings', () => {
    it('is positive on a BUY when the reference is above the execution price', () => {
      // 10,000 x (100.20 - 100.15) = 500
      expect(computeSavings('BUY', dec('10000'), dec('100.15'), dec('100.2')).toString()).toBe('500');
    });

    it('is negative on a SELL when the execution price is below the reference', () => {
      // 10,000 x (99.85 - 100.20) = -3,500
      expect(computeSavings('SELL', dec('10000'), dec('99.85'), dec('100.2')).toString()).toBe('-3500');
    });

    it('rounds the metric HALF_UP at the paise like any other INR figure', () => {
      // Exactly half a paise: 1 x 0.005 = 0.005 -> 0.01 (HALF_UP, not HALF_EVEN).
      expect(computeSavings('BUY', dec('1'), dec('100.195'), dec('100.2')).toString()).toBe('0.01');
      // Below half a paise: 0.03 x 0.03 = 0.0009 -> rounds to 0.
      expect(computeSavings('BUY', dec('0.03'), dec('100.15'), dec('100.18')).toString()).toBe('0');
    });

    it('is exactly zero when the execution and reference prices coincide', () => {
      expect(computeSavings('BUY', dec('10000'), dec('100.15'), dec('100.15')).toString()).toBe('0');
      expect(computeSavings('SELL', dec('10000'), dec('100.15'), dec('100.15')).toString()).toBe('0');
    });
  });

  describe('quoteUsdt', () => {
    it('prices a BUY at the execution VWAP and measures savings against the reference', () => {
      const quote = quoteUsdt('BUY', dec('10000'), dec('100.15'), dec('100.2'));

      expect(quote.inrAmount.toString()).toBe('1001500');
      expect(quote.prometheusPrice.toString()).toBe('100.15');
      expect(quote.referencePrice?.toString()).toBe('100.2');
      expect(quote.savings?.toString()).toBe('500');
      expect(quote.side).toBe('BUY');
    });

    it('suppresses savings when no reference price exists instead of inventing one', () => {
      const quote = quoteUsdt('BUY', dec('10000'), dec('100.15'), null);

      expect(quote.inrAmount.toString()).toBe('1001500');
      expect(quote.referencePrice).toBeNull();
      expect(quote.savings).toBeNull();
    });

    it('refuses zero and negative amounts', () => {
      for (const raw of ['0', '-1', '-0.000001']) {
        expect(() => quoteUsdt('BUY', dec(raw), dec('100.15'), dec('100.2'))).toThrow(DomainException);
      }
    });
  });

  describe('isWithinSanityBand', () => {
    it('accepts a price inside the band around the anchor', () => {
      expect(isWithinSanityBand(dec('100'), dec('100'), 20)).toBe(true);
      expect(isWithinSanityBand(dec('119.99'), dec('100'), 20)).toBe(true);
      expect(isWithinSanityBand(dec('80.01'), dec('100'), 20)).toBe(true);
    });

    it('rejects a price outside the band', () => {
      expect(isWithinSanityBand(dec('120.01'), dec('100'), 20)).toBe(false);
      expect(isWithinSanityBand(dec('79.99'), dec('100'), 20)).toBe(false);
    });

    it('rejects non-positive or non-finite values on either side', () => {
      expect(isWithinSanityBand(dec('0'), dec('100'), 20)).toBe(false);
      expect(isWithinSanityBand(dec('100'), dec('0'), 20)).toBe(false);
      expect(isWithinSanityBand(new Prisma.Decimal('NaN'), dec('100'), 20)).toBe(false);
    });
  });

  describe('venueExecutablePrice', () => {
    it('widens a BUY to the ask and a SELL to the bid by half the reported spread', () => {
      // CoinGecko's spread is (ask - bid) / mid, so half of it applied to the
      // print recovers the offer: 100.00 +/- 0.005%.
      const buy = venueExecutablePrice('BUY', 'WazirX', dec('100'), dec('0.01'));
      const sell = venueExecutablePrice('SELL', 'WazirX', dec('100'), dec('0.01'));

      expect(buy.price.toString()).toBe('100.005');
      expect(buy.basis).toBe('derived_from_spread');
      expect(sell.price.toString()).toBe('99.995');
      expect(sell.basis).toBe('derived_from_spread');
      // Direction always widens away from the print: a BUY can only ever look
      // more expensive and a SELL cheaper, so the derivation never flatters.
      expect(buy.price.gt(dec('100'))).toBe(true);
      expect(sell.price.lt(dec('100'))).toBe(true);
    });

    it('falls back to the raw print when no spread is reported', () => {
      // ZebPay reports no bid/ask spread. Its print is a floor on its ask and a
      // ceiling on its bid, so using it unchanged is the conservative choice.
      const buy = venueExecutablePrice('BUY', 'ZebPay', dec('101.0855'), null);

      expect(buy.price.toString()).toBe('101.0855');
      expect(buy.basis).toBe('last_price');
    });

    it('falls back to the raw print for a zero or implausible spread', () => {
      // A locked market (zero spread) derives to the print itself, which is
      // exactly right; an implausible one describes a broken pair rather than
      // a tradeable one, so it is reported as the raw print instead.
      expect(venueExecutablePrice('BUY', 'A', dec('100'), dec('0')).price.toString()).toBe('100');
      expect(venueExecutablePrice('BUY', 'B', dec('100'), dec('12')).basis).toBe('last_price');
      expect(venueExecutablePrice('BUY', 'C', dec('100'), dec('-1')).basis).toBe('last_price');
    });

    it('refuses a non-positive last price rather than pricing a venue with it', () => {
      expect(() => venueExecutablePrice('BUY', 'A', dec('0'), dec('0.1'))).toThrow(DomainException);
      expect(() => venueExecutablePrice('BUY', 'A', dec('-1'), dec('0.1'))).toThrow(DomainException);
    });
  });

  describe('applyBestPriceGuarantee', () => {
    const venue = (name: string, price: string): VenueExecutablePrice => ({
      venue: name,
      price: dec(price),
      basis: 'derived_from_spread',
    });

    it('caps a BUY a clear ₹1.50 below the cheapest venue, floored so the 2-decimal figure keeps it', () => {
      const guarantee = applyBestPriceGuarantee('BUY', dec('101.11'), [
        venue('CoinDCX', '101.13506'),
        venue('WazirX', '101.0799'),
        venue('ZebPay', '101.0855'),
      ]);

      expect(guarantee.applied).toBe(true);
      expect(guarantee.matchedVenue).toBe('WazirX');
      expect(guarantee.matchedPrice?.toString()).toBe('101.0799');
      // 101.0799 - 1.50 = 99.5799, floored to the paise: a HALF_UP rounding
      // would print 99.58 and hand a paisa of the margin back.
      expect(guarantee.price.toString()).toBe('99.57');
      // The whole point: at least the margin inside every venue the page
      // prints, even after rendering at two decimals.
      for (const raw of ['101.13506', '101.0799', '101.0855']) {
        expect(dec(raw).minus(roundInr(guarantee.price)).gte(MIN_MARKET_ADVANTAGE_INR)).toBe(true);
      }
    });

    it('still caps a BUY that already beats the market, as long as the gap is under the margin', () => {
      // 101.0799 - 100.9 = 0.1799 of advantage: better than every venue, but
      // not by the ₹1.50 the screen promises, so the bound still binds.
      const guarantee = applyBestPriceGuarantee('BUY', dec('100.9'), [
        venue('CoinDCX', '101.13506'),
        venue('WazirX', '101.0799'),
      ]);

      expect(guarantee.applied).toBe(true);
      expect(guarantee.matchedVenue).toBe('WazirX');
      expect(guarantee.price.toString()).toBe('99.57');
    });

    it('leaves a BUY alone once the book is already more than the margin better', () => {
      // The margin is a floor on the advantage, not a levy: a book that
      // already offers 1.5799 of advantage keeps its own better price.
      const guarantee = applyBestPriceGuarantee('BUY', dec('99.5'), [venue('WazirX', '101.0799')]);

      expect(guarantee.applied).toBe(false);
      expect(guarantee.matchedVenue).toBeNull();
      expect(guarantee.price.toString()).toBe('99.5');
    });

    it('floors a SELL a clear ₹1.50 above the highest venue bid, upward to the paise', () => {
      const guarantee = applyBestPriceGuarantee('SELL', dec('99.85'), [
        venue('CoinDCX', '101.125'),
        venue('WazirX', '101.08'),
      ]);

      expect(guarantee.applied).toBe(true);
      expect(guarantee.matchedVenue).toBe('CoinDCX');
      // 101.125 + 1.50 = 102.625, ceiled to the paise so the gap never dips
      // under the margin when the figure is rendered at two decimals.
      expect(guarantee.price.toString()).toBe('102.63');
      for (const raw of ['101.125', '101.08']) {
        expect(roundInr(guarantee.price).minus(dec(raw)).gte(MIN_MARKET_ADVANTAGE_INR)).toBe(true);
      }
    });

    it('leaves a SELL alone once the book bid is already more than the margin better', () => {
      const guarantee = applyBestPriceGuarantee('SELL', dec('103'), [venue('CoinDCX', '101.125')]);

      expect(guarantee.applied).toBe(false);
      expect(guarantee.price.toString()).toBe('103');
    });

    it('passes the book price through untouched when there are no venues', () => {
      // Absent data must never look like a bargain and never like a worse
      // price: the book stands, and the caller reports no guarantee.
      for (const side of ['BUY', 'SELL'] as const) {
        const guarantee = applyBestPriceGuarantee(side, dec('100.15'), []);
        expect(guarantee).toEqual({ price: dec('100.15'), applied: false, matchedVenue: null, matchedPrice: null });
      }
    });
  });
});
