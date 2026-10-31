import { UsdtProviderError } from './usdt-pricing.types';
import {
  parseCoindcxBookSide,
  toEpochMs,
  toOptionalEpochMs,
  toOptionalPositiveDecimalString,
  toPositiveDecimalString,
} from './market-parsing';

/**
 * MODULE 08 extension — the strict parsers that stand between a provider
 * response and anything that prices an order. Timestamp units are the
 * subtlest failure (CoinDCX's book is milliseconds while its ticker is
 * seconds), so both are provoked explicitly, alongside every rejection that
 * keeps a malformed payload from looking like a price.
 */
describe('market-parsing', () => {
  describe('toPositiveDecimalString', () => {
    it('accepts numeric strings and numbers and returns a canonical decimal string', () => {
      expect(toPositiveDecimalString('99.9000000000', 'bid', 'test')).toBe('99.9');
      expect(toPositiveDecimalString(100.1, 'ask', 'test')).toBe('100.1');
    });

    it.each(['0', '-1', 'NaN', 'Infinity', 'abc', '', null, undefined, {}])(
      'rejects the unusable price %s',
      (value) => {
        expect(() => toPositiveDecimalString(value, 'price', 'test')).toThrow(UsdtProviderError);
      },
    );
  });

  describe('toOptionalPositiveDecimalString', () => {
    it('maps absence to null instead of failing', () => {
      expect(toOptionalPositiveDecimalString(null, 'volume', 'test')).toBeNull();
      expect(toOptionalPositiveDecimalString('', 'volume', 'test')).toBeNull();
      expect(toOptionalPositiveDecimalString('12.5', 'volume', 'test')).toBe('12.5');
    });
  });

  describe('toEpochMs', () => {
    // Verified live: the CoinDCX book reports milliseconds, the ticker seconds.
    it('converts a seconds timestamp to milliseconds', () => {
      expect(toEpochMs(1791976983, 'timestamp', 'test')).toBe(1791976983000);
      expect(toEpochMs('1791976983', 'timestamp', 'test')).toBe(1791976983000);
    });

    it('passes a millisecond timestamp through unchanged', () => {
      expect(toEpochMs(1791977309477, 'timestamp', 'test')).toBe(1791977309477);
    });

    it('accepts an ISO-8601 string (CoinGecko venue tickers)', () => {
      expect(toEpochMs('2026-10-14T11:24:00+00:00', 'last_traded_at', 'test')).toBe(
        Date.parse('2026-10-14T11:24:00Z'),
      );
    });

    it.each(['yesterday', 0, -5, null, undefined, ''])(
      'rejects the implausible timestamp %s',
      (value) => {
        expect(() => toEpochMs(value, 'timestamp', 'test')).toThrow(UsdtProviderError);
      },
    );

    it('rejects a timestamp beyond a day in the future', () => {
      const inTwoDays = Date.now() + 2 * 24 * 60 * 60 * 1000;
      expect(() => toEpochMs(inTwoDays, 'timestamp', 'test')).toThrow(/plausible/);
    });
  });

  describe('toOptionalEpochMs', () => {
    it('returns null for absent or unparseable values instead of throwing', () => {
      expect(toOptionalEpochMs(null, 't', 'test')).toBeNull();
      expect(toOptionalEpochMs('never', 't', 'test')).toBeNull();
      expect(toOptionalEpochMs(1791976983, 't', 'test')).toBe(1791976983000);
    });
  });

  describe('parseCoindcxBookSide', () => {
    it('parses the object-map shape CoinDCX actually returns, sorted best-first', () => {
      const levels = parseCoindcxBookSide(
        { '99.9500000000': '1.280000', '99.9000000000': '5000.000000' },
        'asks',
        'test',
      );

      expect(levels).toEqual([
        { price: '99.9', quantity: '5000' },
        { price: '99.95', quantity: '1.28' },
      ]);
    });

    it('sorts bids highest first', () => {
      const levels = parseCoindcxBookSide(
        [
          ['99.8', '10'],
          ['99.9', '20'],
        ],
        'bids',
        'test',
      );

      expect(levels.map((level) => level.price)).toEqual(['99.9', '99.8']);
    });

    it('accepts the array-of-pairs and array-of-objects shapes', () => {
      expect(parseCoindcxBookSide([['100.1', '5']], 'asks', 'test')).toHaveLength(1);
      expect(parseCoindcxBookSide([{ price: '100.1', quantity: '5' }], 'asks', 'test')).toHaveLength(1);
    });

    it('rejects a whole side when any level is malformed rather than pricing on garbage', () => {
      expect(() => parseCoindcxBookSide({ '100.1': 'lots' }, 'asks', 'test')).toThrow(UsdtProviderError);
      expect(() => parseCoindcxBookSide('nope', 'asks', 'test')).toThrow(UsdtProviderError);
      expect(() => parseCoindcxBookSide([['100.1']], 'asks', 'test')).toThrow(UsdtProviderError);
    });

    it('caps the parsed depth so an enormous book cannot become an enormous array', () => {
      const huge: Record<string, string> = {};
      for (let i = 0; i < 300; i += 1) {
        huge[String(100 + i * 0.01)] = '1';
      }

      expect(parseCoindcxBookSide(huge, 'asks', 'test')).toHaveLength(100);
    });
  });
});
