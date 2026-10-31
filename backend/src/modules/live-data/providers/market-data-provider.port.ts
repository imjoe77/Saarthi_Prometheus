import type { MarketInstrument } from '../instruments/instrument-catalogue';

/**
 * MODULE 06c - the boundary between the live market service and any source of
 * quotes and bars, and the token by which that source is supplied.
 *
 * THE PROVIDER IS THE WHOLE STORY OF THIS MODULE. The MarketDataProvider
 * interface is deliberately tiny - one quote read and one bar read, both
 * read-only - because everything else about how live data behaves (staleness
 * thresholds, the session rule, the instrument universe) lives outside the
 * provider, in the service and its pure helpers. A provider is a pipe: it
 * answers "what does the market say right now" as honestly as its source
 * allows, and it never interprets.
 *
 * FIVE PROVIDERS ARE IMPLIED BY THE `mode` TYPE, TWO ARE SHIPPED. `off` is the
 * default and the only safe default: no credentials, no network, and every
 * endpoint honestly reports that the feed is disabled. `fake` is deterministic
 * and programmable, so the entire automated suite - and a developer's first
 * run - can exercise fills, rejects and charts without an API key. `alpaca` is
 * the real public-market-data source and is wired but never contacted by a
 * test; this process never calls any Alpaca *trading* endpoint. A provider
 * that reports a quote through it is a real implementation of this interface,
 * not a stub waiting to be filled in.
 *
 * CONTRACT FOR `null`. `latestQuote` returns `null` rather than throwing when
 * no price can be produced *right now* - the feed is disabled, the provider is
 * unconfigured, the network refused, or the source had no data for the symbol.
 * Absence is a legitimate state of the market (a symbol can genuinely have no
 * quote at a given instant), so it is a value, never an exception. Only a
 * malformed response - a bar that is not a bar - is a bug and may throw.
 */
export const MARKET_DATA_PROVIDER = Symbol('MARKET_DATA_PROVIDER');

export type MarketDataProviderMode = 'off' | 'fake' | 'alpaca';

/** One observable quote, in the provider's own original precision. */
export interface LiveQuote {
  readonly symbol: string;
  /** Best bid, when the source quoted one. */
  readonly bid?: string;
  /** Best ask, when the source quoted one. */
  readonly ask?: string;
  /** When the source published this observation, RFC 3339 UTC. */
  readonly asOf: string;
}

/**
 * One OHLCV bar.
 *
 * Prices are canonical decimal strings exactly as the source reported them,
 * never numbers, so a 0.1+0.2 round trip cannot silently appear downstream.
 */
export interface LiveBar {
  readonly symbol: string;
  readonly timeframe: BarTimeframe;
  /** Bar open instant, RFC 3339 UTC. */
  readonly time: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  /** Base-asset volume, when the source reported it. */
  readonly volume: string;
}

/** The only timeframes the module offers, across every provider. */
export type BarTimeframe = '1m' | '5m' | '15m' | '1h' | '1d';

export interface MarketDataProvider {
  /** Which source this pipe currently is. Never changes for a provider instance. */
  readonly mode: MarketDataProviderMode;

  /**
   * The latest observable quote for an instrument, or null when one cannot be
   * produced right now - see the contract above.
   */
  latestQuote(instrument: MarketInstrument, at: Date): Promise<LiveQuote | null>;

  /**
   * Up to `limit` bars for an instrument, ascending by time, with the most
   * recent bar ending at `at`. An empty array is a valid answer (too little
   * source history, or a feed that has no bars for a symbol); the caller
   * decides what an empty set means.
   */
  bars(instrument: MarketInstrument, timeframe: BarTimeframe, limit: number, at: Date): Promise<LiveBar[]>;
}

/**
 * A quote that wins when no real observation exists: it says clearly that
 * nothing is known. Used by the `off` provider and by `alpaca` when it is
 * unconfigured, and never surfaced as if it were data.
 */
export function noQuote(symbol: string): LiveQuote {
  return { symbol, asOf: new Date(0).toISOString() };
}

export function isQuoteAbsent(quote: LiveQuote): boolean {
  return quote.bid === undefined && quote.ask === undefined;
}