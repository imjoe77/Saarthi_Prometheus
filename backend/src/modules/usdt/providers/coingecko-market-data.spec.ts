import { UsdtProviderError } from './usdt-pricing.types';
import { parseCoinGeckoAggregate, parseCoinGeckoVenues } from './coingecko-market-data';

/**
 * MODULE 08 extension — CoinGecko parsing from live-shaped fixtures
 * (verified 2026-10-14): the aggregate is an INR-converted figure with a
 * seconds timestamp, and venue tickers carry `is_stale`, ISO timestamps and
 * null buy/sell/fee fields for this pair. The BitBNS entry in the real
 * response - last 76.09, stale, traded the previous day - is reproduced here
 * because it is exactly the garbage the staleness rules exist to exclude.
 */
describe('coingecko-market-data parsing', () => {
  describe('parseCoinGeckoAggregate', () => {
    it('parses the live-shaped simple/price payload', () => {
      const aggregate = parseCoinGeckoAggregate({
        tether: { inr: 94.98, last_updated_at: 1791976820 },
      });

      expect(aggregate.priceInr).toBe('94.98');
      expect(aggregate.lastUpdatedAtMs).toBe(1791976820000);
    });

    it.each([
      ['a payload without tether', { bitcoin: { inr: 1 } }],
      ['a payload without an inr price', { tether: { usd: 1 } }],
      ['a zero inr price', { tether: { inr: 0, last_updated_at: 1791976820 } }],
      ['a payload without a timestamp', { tether: { inr: 94.98 } }],
      ['a non-object payload', [1, 2, 3]],
    ])('rejects %s', (_label, payload) => {
      expect(() => parseCoinGeckoAggregate(payload)).toThrow(UsdtProviderError);
    });
  });

  describe('parseCoinGeckoVenues', () => {
    const liveTickers = {
      tickers: [
        {
          market: { name: 'CoinDCX', identifier: 'coindcx' },
          base: 'USDT',
          target: 'INR',
          last: 99.92,
          buy: null,
          sell: null,
          volume: 447609.29,
          last_traded_at: '2026-10-14T11:24:00+00:00',
          last_fetch_at: '2026-10-14T11:23:40+00:00',
          is_stale: false,
          fee: null,
          bid_ask_spread_percentage: 0.01,
        },
        {
          market: { name: 'WazirX', identifier: 'wazirx' },
          base: 'USDT',
          target: 'INR',
          last: 99.66,
          buy: null,
          sell: null,
          volume: 298796.25,
          last_traded_at: '2026-10-14T11:24:00+00:00',
          last_fetch_at: '2026-10-14T11:23:40+00:00',
          is_stale: false,
          fee: null,
          bid_ask_spread_percentage: 0.528995,
        },
        {
          market: { name: 'BitBNS', identifier: 'bitbns' },
          base: 'USDT',
          target: 'INR',
          last: 76.09,
          volume: 81.64,
          last_traded_at: '2026-10-13T21:14:42+00:00',
          last_fetch_at: '2026-10-14T05:14:40+00:00',
          is_stale: true,
          bid_ask_spread_percentage: 2.43621,
        },
        {
          // A non-INR ticker that must be filtered out.
          market: { name: 'WazirX', identifier: 'wazirx' },
          base: 'SOL',
          target: 'USDT',
          last: 106.68,
          is_stale: false,
        },
        {
          // A USDT/INR ticker with a broken price: skipped, not fatal.
          market: { name: 'BrokenVenue', identifier: 'broken' },
          base: 'USDT',
          target: 'INR',
          last: 0,
          is_stale: false,
        },
      ],
    };

    it('keeps USDT/INR venues with their raw prices, flags and timestamps', () => {
      const [coindcx, wazirx, bitbns] = parseCoinGeckoVenues(liveTickers);

      expect(parseCoinGeckoVenues(liveTickers)).toHaveLength(3);
      expect(coindcx).toMatchObject({
        venue: 'CoinDCX',
        lastPriceInr: '99.92',
        staleFlag: false,
        bidAskSpreadPct: '0.01',
      });
      expect(coindcx?.lastTradedAtMs).toBe(Date.parse('2026-10-14T11:24:00Z'));
      expect(coindcx?.fetchedAtMs).toBe(Date.parse('2026-10-14T11:23:40Z'));
      // The stale BitBNS entry survives parsing; freshness is the service's
      // policy - the flag must reach it intact so it can be excluded there.
      expect(bitbns).toMatchObject({ venue: 'BitBNS', lastPriceInr: '76.09', staleFlag: true });
      expect(wazirx?.venue).toBe('WazirX');
    });

    it('keeps a zero spread (valid) and drops a negative one (invalid)', () => {
      const venues = parseCoinGeckoVenues({
        tickers: [
          {
            market: { name: 'Flat', identifier: 'flat' },
            base: 'USDT',
            target: 'INR',
            last: 99.9,
            is_stale: false,
            bid_ask_spread_percentage: 0,
          },
          {
            market: { name: 'Odd', identifier: 'odd' },
            base: 'USDT',
            target: 'INR',
            last: 99.9,
            is_stale: false,
            bid_ask_spread_percentage: -0.5,
          },
        ],
      });

      expect(venues).toHaveLength(2);
      expect(venues[0]?.bidAskSpreadPct).toBe('0');
      expect(venues[1]?.bidAskSpreadPct).toBeNull();
    });

    it.each([
      ['a payload without tickers', {}],
      ['a payload with non-array tickers', { tickers: 'none' }],
      ['a non-object payload', null],
    ])('rejects %s as structurally wrong', (_label, payload) => {
      expect(() => parseCoinGeckoVenues(payload)).toThrow(UsdtProviderError);
    });

    it('returns an empty list when no watched venue traded the pair', () => {
      expect(parseCoinGeckoVenues({ tickers: [] })).toEqual([]);
    });
  });
});
