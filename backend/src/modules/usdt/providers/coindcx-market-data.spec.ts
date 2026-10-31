import { UsdtProviderError } from './usdt-pricing.types';
import { parseCoindcxOrderBook, parseCoindcxUsdtInrTicker } from './coindcx-market-data';

/**
 * MODULE 08 extension — CoinDCX parsing, driven by fixtures shaped exactly
 * like the live responses verified on 2026-10-14: the order book reports a
 * millisecond timestamp with object-map levels, and the ticker is an array of
 * 992 markets keyed by `market` with a seconds timestamp.
 */
describe('coindcx-market-data parsing', () => {
  describe('parseCoindcxOrderBook', () => {
    it('parses a live-shaped payload: ms timestamp, object-map levels, sorted sides', () => {
      const execution = parseCoindcxOrderBook({
        timestamp: 1791977309477,
        asks: {
          '99.9500000000': '1.280000',
          '100.0500000000': '5000.000000',
        },
        bids: {
          '99.9000000000': '447.440000',
          '99.8000000000': '12.000000',
        },
      });

      expect(execution.bookTimestampMs).toBe(1791977309477);
      expect(execution.bestAsk).toBe('99.95');
      expect(execution.bestBid).toBe('99.9');
      expect(execution.askLevels).toEqual([
        { price: '99.95', quantity: '1.28' },
        { price: '100.05', quantity: '5000' },
      ]);
      expect(execution.bidLevels[0]).toEqual({ price: '99.9', quantity: '447.44' });
      // The ticker is filled in separately; absent here it stays null.
      expect(execution.tickerTimestampMs).toBeNull();
      expect(execution.tickerLast).toBeNull();
    });

    it('converts a seconds timestamp, defending against the unit mismatch', () => {
      const execution = parseCoindcxOrderBook({
        timestamp: 1791976983,
        asks: { '100': '1' },
        bids: { '99': '1' },
      });

      expect(execution.bookTimestampMs).toBe(1791976983000);
    });

    it('accepts empty sides - depth is the caller\'s policy, not a parse failure', () => {
      const execution = parseCoindcxOrderBook({ timestamp: Date.now(), asks: {}, bids: {} });

      expect(execution.bestAsk).toBeNull();
      expect(execution.bestBid).toBeNull();
      expect(execution.askLevels).toEqual([]);
    });

    it.each([
      ['a non-object payload', 'https://error'],
      ['a payload without a timestamp', { asks: { '1': '1' }, bids: {} }],
      ['a payload with a future timestamp', { timestamp: Date.now() + 3 * 24 * 60 * 60 * 1000, asks: {}, bids: {} }],
      ['a payload with a negative price level', { timestamp: Date.now(), asks: { '-1': '1' }, bids: {} }],
      ['a payload with non-object sides', { timestamp: Date.now(), asks: 5, bids: {} }],
    ])('rejects %s rather than pricing on it', (_label, payload) => {
      expect(() => parseCoindcxOrderBook(payload)).toThrow(UsdtProviderError);
    });
  });

  describe('parseCoindcxUsdtInrTicker', () => {
    it('finds the USDTINR entry among hundreds and normalises the seconds timestamp', () => {
      const payload = [
        { market: 'BTCUSDT', bid: '83000', ask: '83010', last_price: '83005', timestamp: 1791976980 },
        {
          market: 'USDTINR',
          change_24_hour: '0.42',
          high: '100.24',
          low: '99.42',
          volume: '44721877.46',
          last_price: '99.9000000000',
          bid: '99.9000000000',
          ask: '99.9200000000',
          timestamp: 1791976983,
        },
      ];

      expect(parseCoindcxUsdtInrTicker(payload)).toEqual({
        bid: '99.9',
        ask: '99.92',
        last: '99.9',
        timestampMs: 1791976983000,
      });
    });

    it('returns null when the market is absent instead of failing the book', () => {
      expect(parseCoindcxUsdtInrTicker([{ market: 'BTCUSDT' }])).toBeNull();
      expect(parseCoindcxUsdtInrTicker([])).toBeNull();
    });

    it('rejects a USDTINR entry with an unparseable price', () => {
      expect(() =>
        parseCoindcxUsdtInrTicker([{ market: 'USDTINR', bid: 'soon', ask: '1', last_price: '1', timestamp: 1 }]),
      ).toThrow(UsdtProviderError);
    });

    it('rejects a non-array payload', () => {
      expect(() => parseCoindcxUsdtInrTicker({ market: 'USDTINR' })).toThrow(UsdtProviderError);
    });
  });
});
