import { Injectable } from '@nestjs/common';

import type { MarketInstrument } from '../instruments/instrument-catalogue';
import type { BarTimeframe, LiveBar, LiveQuote, MarketDataProvider } from './market-data-provider.port';

/**
 * MODULE 06c - the deterministic, programmable provider.
 *
 * WHY IT EXISTS. The whole automated suite - fills, rejects, idempotency,
 * charts - runs against this provider, so it must be two things at once:
 * deterministic enough that a test can assert byte-identical output, and
 * programmable enough that a test can stage exactly the market shape it needs
 * (a stale quote, a closed session, a run of bars). Off-by-default and
 * key-free, it is also what a developer sees on a first `npm run dev` with no
 * Alpaca account: a live-feeling panel of plausible quotes and bars, clearly
 * labelled `fake`, that prove the integration end to end without a real feed.
 *
 * DETERMINISM, STATED AS A CONTRACT. When nothing is seeded, `latestQuote`
 * derives its price from (symbol, one-minute bucket): same symbol, same
 * bucket, same string, on any machine, forever. `bars` derives OHLC from
 * (symbol, timeframe, bar bucket), so the same symbol and timeframe always
 * draw the same curve. A seeded quote or bar list overrides the derivation for
 * that key, which is what tests use. These are *stable* numbers, but they are
 * invented - nothing here is a real market observation, and the labels `fake`
 * and `false` on the response DTOs exist precisely so no consumer confuses
 * them for one.
 *
 * PROGRAMMING SURFACE (test doubles). `seedQuote` stages an exact quote for a
 * symbol; `seedBars` stages an exact descending bar list; `clearAll` undoes
 * both. These are not in the provider interface - they are methods on this
 * concrete class, which is how a test obtains them: through the module, then
 * `as FakeMarketDataProvider`.
 */
@Injectable()
export class FakeMarketDataProvider implements MarketDataProvider {
  readonly mode = 'fake' as const;

  /** Base prices that anchor the deterministic wiggle, by canonical symbol. */
  private readonly basePrice: Readonly<Record<string, number>> = {
    AAPL: 232.0,
    MSFT: 429.0,
    NVDA: 138.0,
    TSLA: 262.0,
    AMZN: 198.0,
    'BTC/USD': 97_000,
    'ETH/USD': 3_400,
    'SOL/USD': 172.0,
  };

  private readonly quotes = new Map<string, LiveQuote>();
  private readonly barSets = new Map<string, LiveBar[]>();

  /**
   * Stages an exact quote for a symbol, overriding the deterministic price.
   * `bid`/`ask`/`asOf` default to price and "now" when omitted.
   */
  seedQuote(symbol: string, price: string, options?: { bid?: string; ask?: string; asOf?: string }): void {
    this.quotes.set(symbol, {
      symbol,
      bid: options?.bid ?? price,
      ask: options?.ask ?? price,
      asOf: options?.asOf ?? new Date().toISOString(),
    });
  }

  /** Stages an exact, ascending bar list for (symbol, timeframe). */
  seedBars(symbol: string, timeframe: BarTimeframe, bars: LiveBar[]): void {
    this.barSets.set(this.barKey(symbol, timeframe), [...bars].sort((a, b) => a.time.localeCompare(b.time)));
  }

  /** Drops every staged quote and bar list, returning to pure determinism. */
  clearAll(symbol?: string): void {
    if (symbol === undefined) {
      this.quotes.clear();
      this.barSets.clear();
      return;
    }
    this.quotes.delete(symbol);
    for (const key of [...this.barSets.keys()]) {
      if (key.startsWith(`${symbol}|`)) {
        this.barSets.delete(key);
      }
    }
  }

  /**
   * Synchronous by design. The derivation is pure arithmetic over (symbol,
   * minute bucket), so making it async would only add a microtask hop between
   * the caller and a number that is already known.
   */
  latestQuote(instrument: MarketInstrument, at: Date): Promise<LiveQuote | null> {
    const staged = this.quotes.get(instrument.symbol);
    if (staged) {
      return Promise.resolve(staged);
    }

    const base = this.basePrice[instrument.symbol];
    if (base === undefined) {
      return Promise.resolve(null);
    }

    const bucket = Math.floor(at.getTime() / 60_000);
    const wiggle = (hash(`${instrument.symbol}:${bucket}`) - 0.5) * 0.01; // ±0.5%
    const bid = round(base * (1 + wiggle - 0.0005));
    const ask = round(base * (1 + wiggle + 0.0005));

    return Promise.resolve({
      symbol: instrument.symbol,
      bid: String(bid),
      ask: String(ask),
      asOf: at.toISOString(),
    });
  }

  bars(instrument: MarketInstrument, timeframe: BarTimeframe, limit: number, at: Date): Promise<LiveBar[]> {
    const staged = this.barSets.get(this.barKey(instrument.symbol, timeframe));
    if (staged) {
      return Promise.resolve(staged.slice(-limit));
    }

    const base = this.basePrice[instrument.symbol];
    if (base === undefined) {
      return Promise.resolve([]);
    }

    const stepMs = timeframeStepMs(timeframe);
    const lastBucket = barBucketAt(at, timeframe);
    const bars: LiveBar[] = [];

    let previousClose = base;
    for (let i = 0; i < limit; i += 1) {
      const openMs = lastBucket - (limit - 1 - i) * stepMs;
      const openTime = new Date(openMs).toISOString();
      const bucket = Math.floor(openMs / stepMs);
      const dir = (hash(`${instrument.symbol}:${timeframe}:${bucket}`) - 0.5) * 0.008; // ±0.4%
      const close = previousClose * (1 + dir);
      const high = Math.max(open(previousClose, dir), close) * (1 + 0.0002);
      const low = Math.min(open(previousClose, dir), close) * (1 - 0.0002);

      bars.push({
        symbol: instrument.symbol,
        timeframe,
        time: openTime,
        open: String(round(open(previousClose, dir))),
        high: String(round(high)),
        low: String(round(low)),
        close: String(round(close)),
        volume: String(1_000 + (hash(`${instrument.symbol}:${timeframe}:${bucket}:v`) % 9_000)),
      });

      previousClose = close;
    }

    return Promise.resolve(bars);
  }

  /** Reports whether a symbol has a staged quote, for tests and diagnostics. */
  hasStagedQuote(symbol: string): boolean {
    return this.quotes.has(symbol);
  }

  private barKey(symbol: string, timeframe: BarTimeframe): string {
    return `${symbol}|${timeframe}`;
  }
}

function open(previousClose: number, direction: number): number {
  return previousClose * (1 + direction * 0.5);
}

/**
 * 53-bit string hash, deliberately simple and stable.
 *
 * Not a cryptographic hash and never used as one: it only needs to map an
 * input string to a stable double in [0, 1) so the whole deterministic curve
 * does not depend on `Math.random` or on object iteration order.
 */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0x100000000;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function timeframeStepMs(timeframe: BarTimeframe): number {
  switch (timeframe) {
    case '1m':
      return 60_000;
    case '5m':
      return 5 * 60_000;
    case '15m':
      return 15 * 60_000;
    case '1h':
      return 60 * 60_000;
    case '1d':
      return 24 * 60 * 60_000;
  }
}

export function barBucketAt(at: Date, timeframe: BarTimeframe): number {
  const stepMs = timeframeStepMs(timeframe);
  return Math.floor(at.getTime() / stepMs) * stepMs;
}