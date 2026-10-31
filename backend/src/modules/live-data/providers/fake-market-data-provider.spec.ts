import { findInstrument } from '../instruments/instrument-catalogue';
import { barBucketAt, FakeMarketDataProvider, timeframeStepMs } from './fake-market-data-provider';

/**
 * MODULE 06c - the deterministic, programmable provider.
 *
 * The contract this suite pins is determinism: the same symbol, the same
 * one-minute bucket and the same machine must produce the same strings, forever,
 * with no `Math.random` anywhere in the path. That is what lets the whole
 * automated suite run against invented prices and still assert byte-identical
 * output - and it is why a seeded quote must override the derivation rather than
 * perturb it.
 */
describe('FakeMarketDataProvider', () => {
  const SOL = findInstrument('SOL/USD')!;
  const AAPL = findInstrument('AAPL')!;
  const DOGE = { ...SOL, symbol: 'DOGE/USD' };

  /** A fixed instant, so nothing in this suite depends on the wall clock. */
  const AT = new Date('2026-01-05T15:00:00.000Z');

  let provider: FakeMarketDataProvider;

  beforeEach(() => {
    provider = new FakeMarketDataProvider();
  });

  it('identifies itself as fake, which is what keeps it off a live panel', () => {
    expect(provider.mode).toBe('fake');
  });

  describe('determinism', () => {
    it('produces the identical quote for the same symbol and minute bucket', async () => {
      const first = await provider.latestQuote(SOL, AT);
      const second = await provider.latestQuote(SOL, new Date(AT.getTime()));

      expect(first).toEqual(second);
      expect(first?.bid).toBe(second?.bid);
      expect(first?.ask).toBe(second?.ask);
    });

    it('varies across minute buckets rather than repeating one price forever', async () => {
      // A single step is not enough to prove variation - the wiggle is only
      // ±0.5% and prices round to two places, so two adjacent buckets can
      // legitimately collide. A run of buckets cannot.
      const bids = new Set<string>();
      for (let i = 0; i < 30; i += 1) {
        const quote = await provider.latestQuote(SOL, new Date(AT.getTime() + i * 60_000));
        bids.add(quote?.bid ?? '');
      }

      expect(bids.size).toBeGreaterThan(1);
    });

    it('produces the identical bar series for the same symbol and timeframe', async () => {
      const first = await provider.bars(SOL, '5m', 10, AT);
      const second = await provider.bars(SOL, '5m', 10, new Date(AT.getTime()));

      expect(first).toEqual(second);
    });

    it('always quotes a spread, with the bid below the ask', async () => {
      for (const instrument of [SOL, AAPL]) {
        const quote = await provider.latestQuote(instrument, AT);
        expect(quote).not.toBeNull();
        expect(Number(quote?.bid)).toBeLessThan(Number(quote?.ask));
      }
    });

    it('anchors each instrument near its own base price', async () => {
      const sol = await provider.latestQuote(SOL, AT);
      const aapl = await provider.latestQuote(AAPL, AT);

      // The wiggle is ±0.5%, so a quote stays inside a tight band around its
      // base: SOL/USD 172 and AAPL 232.
      expect(Number(sol?.bid)).toBeGreaterThan(165);
      expect(Number(sol?.bid)).toBeLessThan(180);
      expect(Number(aapl?.bid)).toBeGreaterThan(220);
      expect(Number(aapl?.bid)).toBeLessThan(245);
    });

    it('stamps the quote with the instant it was asked for', async () => {
      const quote = await provider.latestQuote(SOL, AT);

      expect(quote?.asOf).toBe(AT.toISOString());
      expect(quote?.symbol).toBe('SOL/USD');
    });

    it('returns no quote for a symbol outside the base-price table', async () => {
      expect(await provider.latestQuote(DOGE, AT)).toBeNull();
    });

    it('returns no bars for a symbol outside the base-price table', async () => {
      expect(await provider.bars(DOGE, '1m', 5, AT)).toEqual([]);
    });
  });

  describe('bars', () => {
    it('returns exactly the number of bars asked for', async () => {
      for (const limit of [1, 5, 50]) {
        expect(await provider.bars(SOL, '1m', limit, AT)).toHaveLength(limit);
      }
    });

    it('returns bars ascending by time, ending at the requested instant', async () => {
      const bars = await provider.bars(SOL, '15m', 10, AT);

      expect(bars.map((b) => b.time)).toEqual([...bars.map((b) => b.time)].sort());
      expect(bars.at(-1)?.time).toBe(new Date(barBucketAt(AT, '15m')).toISOString());
    });

    it('carries the requested symbol and timeframe on every bar', async () => {
      const bars = await provider.bars(AAPL, '1h', 3, AT);

      for (const bar of bars) {
        expect(bar.symbol).toBe('AAPL');
        expect(bar.timeframe).toBe('1h');
      }
    });

    it('produces a high at or above both the open and the close, and a low at or below', async () => {
      const bars = await provider.bars(SOL, '1m', 25, AT);

      for (const bar of bars) {
        const high = Number(bar.high);
        const low = Number(bar.low);
        const open = Number(bar.open);
        const close = Number(bar.close);

        expect(high).toBeGreaterThanOrEqual(Math.max(open, close));
        expect(low).toBeLessThanOrEqual(Math.min(open, close));
      }
    });

    it('chains each bar off the previous close, so the series is continuous', async () => {
      const bars = await provider.bars(SOL, '1m', 5, AT);

      for (let i = 1; i < bars.length; i += 1) {
        const previousClose = Number(bars[i - 1]?.close);
        const open = Number(bars[i]?.open);
        // The open is the previous close nudged by half a step, so it sits very
        // close to it - never at a wholly unrelated price.
        expect(Math.abs(open - previousClose) / previousClose).toBeLessThan(0.01);
      }
    });

    it('gives every bar a positive volume', async () => {
      const bars = await provider.bars(SOL, '1m', 20, AT);

      for (const bar of bars) {
        expect(Number(bar.volume)).toBeGreaterThan(0);
      }
    });
  });

  describe('test programming surface', () => {
    it('lets a seeded quote override the deterministic derivation exactly', async () => {
      provider.seedQuote('SOL/USD', '170', { bid: '169.5', ask: '170.5', asOf: AT.toISOString() });

      const quote = await provider.latestQuote(SOL, AT);

      expect(quote).toEqual({
        symbol: 'SOL/USD',
        bid: '169.5',
        ask: '170.5',
        asOf: AT.toISOString(),
      });
      expect(provider.hasStagedQuote('SOL/USD')).toBe(true);
    });

    it('defaults a seeded quote bid, ask and asOf sensibly', async () => {
      provider.seedQuote('SOL/USD', '42');

      const quote = await provider.latestQuote(SOL, AT);

      expect(quote?.bid).toBe('42');
      expect(quote?.ask).toBe('42');
      expect(Date.parse(quote?.asOf ?? '')).not.toBeNaN();
    });

    it('returns a seeded bar list in place of the derived one', async () => {
      const staged = [
        {
          symbol: 'SOL/USD',
          timeframe: '1m' as const,
          time: '2026-01-05T14:58:00.000Z',
          open: '1',
          high: '2',
          low: '0.5',
          close: '1.5',
          volume: '10',
        },
        {
          symbol: 'SOL/USD',
          timeframe: '1m' as const,
          time: '2026-01-05T14:59:00.000Z',
          open: '1.5',
          high: '3',
          low: '1',
          close: '2.5',
          volume: '20',
        },
      ];

      provider.seedBars('SOL/USD', '1m', staged);

      expect(await provider.bars(SOL, '1m', 10, AT)).toEqual(staged);
      // Still limited by the caller's request.
      expect(await provider.bars(SOL, '1m', 1, AT)).toHaveLength(1);
    });

    it('sorts a seeded bar list ascending, so a test cannot stage an unordered chart', async () => {
      provider.seedBars('SOL/USD', '1m', [
        {
          symbol: 'SOL/USD',
          timeframe: '1m',
          time: '2026-01-05T15:01:00.000Z',
          open: '1',
          high: '1',
          low: '1',
          close: '1',
          volume: '1',
        },
        {
          symbol: 'SOL/USD',
          timeframe: '1m',
          time: '2026-01-05T15:00:00.000Z',
          open: '2',
          high: '2',
          low: '2',
          close: '2',
          volume: '2',
        },
      ]);

      const bars = await provider.bars(SOL, '1m', 10, AT);

      expect(bars.map((b) => b.time)).toEqual([
        '2026-01-05T15:00:00.000Z',
        '2026-01-05T15:01:00.000Z',
      ]);
    });

    it('scopes seeded bars to one symbol and timeframe', async () => {
      provider.seedQuote('SOL/USD', '1');

      expect(provider.hasStagedQuote('AAPL')).toBe(false);

      // The derived quote for AAPL is unaffected by staging SOL.
      const aapl = await provider.latestQuote(AAPL, AT);
      expect(aapl?.bid).not.toBe('1');
    });

    it('clears a single symbol, leaving others staged', () => {
      provider.seedQuote('SOL/USD', '1');
      provider.seedQuote('AAPL', '2');

      provider.clearAll('SOL/USD');

      expect(provider.hasStagedQuote('SOL/USD')).toBe(false);
      expect(provider.hasStagedQuote('AAPL')).toBe(true);
    });

    it('clears every symbol and timeframe when asked with no argument', async () => {
      provider.seedQuote('SOL/USD', '1');
      provider.seedBars('SOL/USD', '1m', []);

      provider.clearAll();

      expect(provider.hasStagedQuote('SOL/USD')).toBe(false);
      // Back to pure derivation rather than an empty bar list.
      expect(await provider.bars(SOL, '1m', 3, AT)).toHaveLength(3);
    });

    it('clears only the named symbol, leaving another symbol staged bar set intact', async () => {
      const stagedAapl = [
        {
          symbol: 'AAPL',
          timeframe: '1m' as const,
          time: '2026-01-05T15:00:00.000Z',
          open: '1',
          high: '1',
          low: '1',
          close: '1',
          volume: '1',
        },
      ];
      provider.seedBars('SOL/USD', '1m', []);
      provider.seedBars('AAPL', '1m', stagedAapl);

      provider.clearAll('SOL/USD');

      // The cleared symbol falls back to derivation and returns the three bars
      // asked for rather than the empty staged list...
      expect(await provider.bars(SOL, '1m', 3, AT)).toHaveLength(3);
      // ...while the other symbol still answers from its staged set.
      expect(await provider.bars(AAPL, '1m', 3, AT)).toEqual(stagedAapl);
    });
  });
});

describe('timeframe helpers', () => {
  it('maps each timeframe to its own step in milliseconds', () => {
    expect(timeframeStepMs('1m')).toBe(60_000);
    expect(timeframeStepMs('5m')).toBe(300_000);
    expect(timeframeStepMs('15m')).toBe(900_000);
    expect(timeframeStepMs('1h')).toBe(3_600_000);
    expect(timeframeStepMs('1d')).toBe(86_400_000);
  });

  it('floors an instant onto the bar bucket that contains it', () => {
    const at = new Date('2026-01-05T15:07:33.456Z');

    expect(barBucketAt(at, '1m')).toBe(Date.parse('2026-01-05T15:07:00.000Z'));
    expect(barBucketAt(at, '5m')).toBe(Date.parse('2026-01-05T15:05:00.000Z'));
    expect(barBucketAt(at, '15m')).toBe(Date.parse('2026-01-05T15:00:00.000Z'));
    expect(barBucketAt(at, '1h')).toBe(Date.parse('2026-01-05T15:00:00.000Z'));
    expect(barBucketAt(at, '1d')).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
  });

  it('leaves an instant that is exactly on a bucket unchanged', () => {
    const at = new Date('2026-01-05T15:05:00.000Z');

    expect(barBucketAt(at, '5m')).toBe(at.getTime());
  });
});
