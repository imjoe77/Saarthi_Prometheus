import { AppConfig, UsdtPricingConfig } from '../../../config/app.config';
import { LiveUsdtPricingProvider } from './live-usdt-pricing.provider';

/**
 * MODULE 08 extension — the last-good-reading resilience of the live provider.
 *
 * A single failed upstream pass used to empty the competitor table and drop the
 * page to the configured fallback, even though the market had only blinked.
 * These tests drive the provider's own fetch layer (global fetch, mocked) so
 * the reuse rules are asserted where they live:
 *
 * - a failed CoinDCX/CoinGecko call reuses the last good reading for that
 *   source, tagged `executionReused` / `referenceReused`,
 * - never outside the same freshness window the service enforces anyway, so a
 *   reused reading cannot be older than a fetched one could be,
 * - a reused book keeps its original fetch time, because the UI's "book
 *   captured" figure must not pretend the data is newer than it is,
 * - and with no reading to reuse the snapshot stays honestly empty - absent
 *   data is never dressed up as present.
 */

const ORDERBOOK_URL = 'https://unit.test/coindcx/orderbook';
const TICKER_URL = 'https://unit.test/coindcx/ticker';
const COINGECKO_BASE = 'https://unit.test/coingecko';

/** Which upstreams should fail on the next pass, by URL substring. */
let failing: string[] = [];

/** The book timestamp the mock last served, so reuse can be pinned exactly. */
let bookTimestampMs = 0;

function ok(payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

function mockFetch(url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const fail = failing.find((fragment) => url.includes(fragment));
  if (fail) return Promise.reject(new Error(`simulated outage for ${fail}`));

  bookTimestampMs = Date.now();
  const nowSec = Math.floor(bookTimestampMs / 1000);

  if (url.includes('orderbook')) {
    return Promise.resolve(
      ok({
        timestamp: bookTimestampMs,
        asks: { '100.1': '5000', '100.2': '5000' },
        bids: { '99.9': '5000', '99.8': '5000' },
      }),
    );
  }
  if (url.includes('coindcx/ticker')) {
    return Promise.resolve(ok([{ market: 'USDTINR', bid: '99.9', ask: '100.1', last_price: '100', timestamp: nowSec }]));
  }
  if (url.includes('simple/price')) {
    return Promise.resolve(ok({ tether: { inr: 100.1, last_updated_at: nowSec } }));
  }
  return Promise.resolve(
    ok({
      tickers: [
        {
          market: { name: 'AlphaExchange', identifier: 'alpha' },
          base: 'USDT',
          target: 'INR',
          last: 100.25,
          volume: 1234.5,
          last_traded_at: new Date(bookTimestampMs).toISOString(),
          last_fetch_at: new Date(bookTimestampMs).toISOString(),
          is_stale: false,
          bid_ask_spread_percentage: 0.02,
        },
      ],
    }),
  );
}

function provider(overrides: Partial<ConstructorParameters<typeof UsdtPricingConfig>[0]> = {}): LiveUsdtPricingProvider {
  return new LiveUsdtPricingProvider(
    new AppConfig({
      usdtPricing: new UsdtPricingConfig({
        provider: 'live',
        coinGeckoBaseUrl: COINGECKO_BASE,
        coindcxOrderbookUrl: ORDERBOOK_URL,
        coindcxTickerUrl: TICKER_URL,
        // Every call must reach the network layer: a cache hit would hide the
        // very failure path these tests exist to exercise.
        cacheTtlMs: 0,
        fetchTimeoutMs: 500,
        ...overrides,
      }),
    }),
  );
}

describe('live-usdt-pricing provider last-good reuse', () => {
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    failing = [];
    bookTimestampMs = 0;
  });

  it('serves a fresh snapshot on a healthy pass, with no reuse flags set', async () => {
    const snapshot = await provider().getSnapshot();

    expect(snapshot.execution).not.toBeNull();
    expect(snapshot.executionReused).toBe(false);
    expect(snapshot.referenceReused).toBe(false);
    expect(snapshot.executionError).toBeNull();
    expect(snapshot.referenceError).toBeNull();
    expect(snapshot.competitors.map((venue) => venue.venue)).toEqual(['AlphaExchange']);
    expect(snapshot.aggregate?.priceInr).toBe('100.1');
  });

  it('reuses the last good book when CoinDCX fails, keeping the original fetch time', async () => {
    const underTest = provider();

    const first = await underTest.getSnapshot();
    const firstFetchedAtMs = first.fetchedAtMs;
    const firstBookTimestampMs = first.execution?.bookTimestampMs;

    failing = ['orderbook'];
    const second = await underTest.getSnapshot();

    expect(second.executionReused).toBe(true);
    expect(second.executionError).not.toBeNull();
    // The same reading, not a fresh one - and its age stays honest.
    expect(second.execution?.bookTimestampMs).toBe(firstBookTimestampMs);
    expect(second.fetchedAtMs).toBe(firstFetchedAtMs);
    // The reference half of the pass was healthy and is reported as such.
    expect(second.referenceReused).toBe(false);
    expect(second.aggregate?.priceInr).toBe('100.1');
  });

  it('refuses to reuse a book once it is past the execution freshness window', async () => {
    const underTest = provider({ maxAgeMs: 5 });

    const first = await underTest.getSnapshot();
    expect(first.executionReused).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    failing = ['orderbook'];
    const second = await underTest.getSnapshot();

    // Older than anything the service would have accepted, so it is dropped
    // rather than replayed: the page falls back exactly as it did before.
    expect(second.execution).toBeNull();
    expect(second.executionReused).toBe(false);
    expect(second.executionError).not.toBeNull();
  });

  it('reuses the last good reference when CoinGecko fails, leaving the fresh book alone', async () => {
    const underTest = provider();

    await underTest.getSnapshot();

    failing = ['simple/price', 'tickers'];
    const second = await underTest.getSnapshot();

    expect(second.referenceReused).toBe(true);
    expect(second.referenceError).not.toBeNull();
    expect(second.aggregate?.priceInr).toBe('100.1');
    expect(second.competitors.map((venue) => venue.venue)).toEqual(['AlphaExchange']);
    expect(second.executionReused).toBe(false);
    expect(second.execution).not.toBeNull();
  });

  it('keeps one half of the reference fresh when only the other half fails', async () => {
    const underTest = provider();

    await underTest.getSnapshot();

    failing = ['simple/price'];
    const second = await underTest.getSnapshot();

    // The aggregate is replayed, the venue list is a genuine fresh fetch.
    expect(second.referenceReused).toBe(true);
    expect(second.aggregate?.priceInr).toBe('100.1');
    expect(second.competitors).toHaveLength(1);
    expect(second.referenceError).toContain('coingecko_aggregate');
    expect(second.referenceError).not.toContain('coingecko_venues');
  });

  it('reports nothing rather than a reuse when there is no last good reading', async () => {
    failing = ['orderbook', 'simple/price', 'tickers'];

    const snapshot = await provider().getSnapshot();

    expect(snapshot.execution).toBeNull();
    expect(snapshot.executionReused).toBe(false);
    expect(snapshot.aggregate).toBeNull();
    expect(snapshot.competitors).toEqual([]);
    expect(snapshot.referenceReused).toBe(false);
    expect(snapshot.executionError).not.toBeNull();
    expect(snapshot.referenceError).not.toBeNull();
  });
});
