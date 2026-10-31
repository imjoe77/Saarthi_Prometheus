import { normalizeBars, normalizeLatestQuotes } from './alpaca-normalizers';

/**
 * MODULE 06c - decoding the payloads Alpaca actually sends.
 *
 * The fixtures below are the two shapes the module reads: the equities family
 * (`/v2/stocks/...`) and the crypto family (`/v1beta1/crypto/us/...`). They share
 * an envelope but differ in the details that break naive casts - crypto bars
 * carry a per-bar `s` symbol, timestamps arrive as either epoch seconds or epoch
 * milliseconds, and a field can be present-but-null.
 *
 * The theme across every case is that a malformed payload yields *absence*, not
 * an exception: a changed upstream field must turn into "no data right now"
 * rather than a 500.
 */
describe('alpaca-normalizers', () => {
  describe('normalizeLatestQuotes', () => {
    it('decodes the equities latest-quotes envelope', () => {
      const quotes = normalizeLatestQuotes({
        quotes: {
          AAPL: { t: 1_767_612_000_000, ap: 232.1, bp: 231.9 },
        },
      });

      expect(quotes).toHaveLength(1);
      expect(quotes[0]?.symbol).toBe('AAPL');
      expect(quotes[0]?.bid).toBe('231.9');
      expect(quotes[0]?.ask).toBe('232.1');
      expect(quotes[0]?.asOf).toBe(new Date(1_767_612_000_000).toISOString());
    });

    it('decodes the crypto envelope, which shares the same shape', () => {
      const quotes = normalizeLatestQuotes({
        quotes: {
          'BTC/USD': { t: 1_767_612_000_000, ap: '97000.5', bp: '96999.5' },
        },
      });

      expect(quotes).toHaveLength(1);
      expect(quotes[0]?.symbol).toBe('BTC/USD');
      expect(quotes[0]?.bid).toBe('96999.5');
      expect(quotes[0]?.ask).toBe('97000.5');
    });

    it('decodes several symbols at once', () => {
      const quotes = normalizeLatestQuotes({
        quotes: {
          AAPL: { bp: 231.9, ap: 232.1 },
          MSFT: { bp: 428.9, ap: 429.1 },
          NVDA: { bp: 137.9, ap: 138.1 },
        },
      });

      expect(quotes.map((q) => q.symbol).sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
    });

    it('preserves the source digits as strings, never as binary floats', () => {
      // 0.1 + 0.2 is the classic double trap; the string must survive untouched.
      const quotes = normalizeLatestQuotes({ quotes: { X: { bp: 0.1, ap: 0.3 } } });

      expect(quotes[0]?.bid).toBe('0.1');
      expect(quotes[0]?.ask).toBe('0.3');
    });

    it('accepts string prices, because some upstream paths serialise them', () => {
      const quotes = normalizeLatestQuotes({ quotes: { X: { bp: '1.5', ap: '2.5' } } });

      expect(quotes[0]?.bid).toBe('1.5');
      expect(quotes[0]?.ask).toBe('2.5');
    });

    it('drops a quote that has neither bid nor ask, rather than inventing a price', () => {
      const quotes = normalizeLatestQuotes({
        quotes: {
          AAPL: { bp: 231.9, ap: 232.1 },
          EMPTY: { t: 1_767_612_000_000 },
        },
      });

      expect(quotes).toHaveLength(1);
      expect(quotes[0]?.symbol).toBe('AAPL');
    });

    it('drops a quote whose only price is null', () => {
      const quotes = normalizeLatestQuotes({ quotes: { X: { bp: null, ap: null } } });

      expect(quotes).toEqual([]);
    });

    it('keeps a one-sided quote, since a bid alone is still an observation', () => {
      const bidOnly = normalizeLatestQuotes({ quotes: { X: { bp: 10 } } });
      expect(bidOnly[0]?.bid).toBe('10');
      expect(bidOnly[0]?.ask).toBeUndefined();

      const askOnly = normalizeLatestQuotes({ quotes: { X: { ap: 11 } } });
      expect(askOnly[0]?.ask).toBe('11');
      expect(askOnly[0]?.bid).toBeUndefined();
    });

    it('returns an empty list for a payload with no quotes key at all', () => {
      expect(normalizeLatestQuotes({})).toEqual([]);
      expect(normalizeLatestQuotes({ quotes: {} })).toEqual([]);
      expect(normalizeLatestQuotes(undefined)).toEqual([]);
      expect(normalizeLatestQuotes(null)).toEqual([]);
      expect(normalizeLatestQuotes('not a payload')).toEqual([]);
    });

    it('renders an unusable timestamp as the empty string rather than throwing', () => {
      const quotes = normalizeLatestQuotes({ quotes: { X: { bp: 1, ap: 2, t: 'not-a-date' } } });

      expect(quotes[0]?.asOf).toBe('');
    });
  });

  describe('normalizeBars', () => {
    const EQUITY_BAR = {
      t: 1_767_612_000_000,
      o: 231.5,
      h: 233.0,
      l: 231.0,
      c: 232.75,
      v: 1_000_000,
    };

    /**
     * Alpaca answers with `{ bars: { SYMBOL: [ ... ] } }` - a map keyed by the
     * requested symbol, not a bare list - so every fixture carries the envelope
     * the network actually delivers.
     */
    const withBars = (symbol: string, barList: unknown): { bars: Record<string, unknown> } => ({
      bars: { [symbol]: barList },
    });

    it('decodes an equities bar map into canonical bars', () => {
      const bars = normalizeBars(withBars('AAPL', [EQUITY_BAR]), 'AAPL', '1m');

      expect(bars).toHaveLength(1);
      expect(bars[0]).toEqual({
        symbol: 'AAPL',
        timeframe: '1m',
        time: new Date(1_767_612_000_000).toISOString(),
        open: '231.5',
        high: '233',
        low: '231',
        close: '232.75',
        volume: '1000000',
      });
    });

    it('lets a crypto per-bar symbol override the caller-supplied one', () => {
      const bars = normalizeBars(
        withBars('ETH/USD', [{ ...EQUITY_BAR, s: 'BTC/USD' }]),
        'ETH/USD',
        '5m',
      );

      expect(bars[0]?.symbol).toBe('BTC/USD');
    });

    it('matches the map key case-insensitively, so a lowercase request still finds its bars', () => {
      const bars = normalizeBars(withBars('BTC/USD', [EQUITY_BAR]), 'btc/usd', '1d');

      expect(bars).toHaveLength(1);
      expect(bars[0]?.symbol).toBe('BTC/USD');
    });

    it('decodes a bare bar array when the upstream sends the legacy list shape', () => {
      const bars = normalizeBars({ bars: [EQUITY_BAR] }, 'AAPL', '1m');

      expect(bars).toHaveLength(1);
      expect(bars[0]?.close).toBe('232.75');
    });

    it('decodes a map holding a single entry when the key is not the request symbol', () => {
      const bars = normalizeBars(withBars('AAPL', [EQUITY_BAR]), 'MSFT', '1h');

      expect(bars).toHaveLength(1);
    });

    it('ignores other keys when the map is multi-symbol and none matches', () => {
      const bars = normalizeBars(
        { bars: { 'ETH/USD': [EQUITY_BAR], 'SOL/USD': [EQUITY_BAR] } },
        'AAPL',
        '1h',
      );

      expect(bars).toEqual([]);
    });

    it('treats a null bar list for the requested symbol as no bars', () => {
      expect(normalizeBars({ bars: { AAPL: null } }, 'AAPL', '1m')).toEqual([]);
    });

    it('uses the caller symbol when the bar carries none, as equities bars do not', () => {
      const bars = normalizeBars(withBars('MSFT', [EQUITY_BAR]), 'MSFT', '1h');

      expect(bars[0]?.symbol).toBe('MSFT');
      expect(bars[0]?.timeframe).toBe('1h');
    });

    it('stamps every bar with the requested timeframe', () => {
      for (const timeframe of ['1m', '5m', '15m', '1h', '1d'] as const) {
        const bars = normalizeBars(withBars('AAPL', [EQUITY_BAR]), 'AAPL', timeframe);
        expect(bars[0]?.timeframe).toBe(timeframe);
      }
    });

    it('drops a bar with no open time or no close, because it cannot be a bar', () => {
      const bars = normalizeBars(
        withBars('AAPL', [
          EQUITY_BAR,
          { ...EQUITY_BAR, t: undefined },
          { ...EQUITY_BAR, c: undefined },
          { ...EQUITY_BAR, o: undefined },
        ]),
        'AAPL',
        '1m',
      );

      expect(bars).toHaveLength(1);
    });

    it('sorts ascending by time, whatever order the source returned', () => {
      const bars = normalizeBars(
        withBars('AAPL', [
          { ...EQUITY_BAR, t: 1_767_612_120_000 },
          { ...EQUITY_BAR, t: 1_767_612_000_000 },
          { ...EQUITY_BAR, t: 1_767_612_060_000 },
        ]),
        'AAPL',
        '1m',
      );

      expect(bars.map((b) => b.time)).toEqual([...bars.map((b) => b.time)].sort());
      expect(bars).toHaveLength(3);
    });

    it('accepts epoch seconds as well as epoch milliseconds', () => {
      const millis = normalizeBars(withBars('AAPL', [{ ...EQUITY_BAR, t: 1_767_612_000_000 }]), 'AAPL', '1m');
      const seconds = normalizeBars(withBars('AAPL', [{ ...EQUITY_BAR, t: 1_767_612_000 }]), 'AAPL', '1m');

      expect(millis[0]?.time).toBe(seconds[0]?.time);
    });

    it('defaults a missing volume to zero instead of omitting the field', () => {
      const bars = normalizeBars(withBars('AAPL', [{ ...EQUITY_BAR, v: undefined }]), 'AAPL', '1m');

      expect(bars[0]?.volume).toBe('0');
    });

    it('defaults missing high and low to zero, keeping the six-field bar shape', () => {
      const bars = normalizeBars(
        withBars('AAPL', [{ t: EQUITY_BAR.t, o: 1, c: 2 }]),
        'AAPL',
        '1m',
      );

      expect(bars[0]?.high).toBe('0');
      expect(bars[0]?.low).toBe('0');
    });

    it('returns an empty list for a payload that is not a bars envelope', () => {
      expect(normalizeBars({}, 'AAPL', '1m')).toEqual([]);
      expect(normalizeBars({ bars: null }, 'AAPL', '1m')).toEqual([]);
      expect(normalizeBars({ bars: {} }, 'AAPL', '1m')).toEqual([]);
      expect(normalizeBars(undefined, 'AAPL', '1m')).toEqual([]);
      expect(normalizeBars(null, 'AAPL', '1m')).toEqual([]);
    });
  });
});
