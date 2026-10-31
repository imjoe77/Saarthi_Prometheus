import type { UsdtFakePricingScenario, UsdtPricingProviderKey } from '../../../config/app.config';

/**
 * MODULE 08 extension — the port between USDT pricing and its data sources.
 *
 * A snapshot is the validated output of one provider pass: the CoinDCX
 * execution book (or the reason it is missing), the CoinGecko aggregate and
 * competitor venues (or the reason they are missing). Every figure is a
 * canonical decimal string or an epoch-millisecond timestamp - the service
 * layer converts to Decimal, keeping parsing and policy apart.
 *
 * Errors carry a source label and a short reason; they never carry response
 * bodies, URLs with credentials or the CoinGecko key, which stays in an HTTP
 * header on the live provider only.
 */

/** Injection token for the configured {@link UsdtPricingProvider}. */
export const USDT_PRICING_PROVIDER = Symbol('USDT_PRICING_PROVIDER');

export type { UsdtFakePricingScenario, UsdtPricingProviderKey };

/** One order-book level as validated decimal strings. */
export interface BookLevelStrings {
  price: string;
  quantity: string;
}

/** CoinDCX USDT/INR execution data: the order book plus optional ticker cross-check. */
export interface CoindcxExecution {
  bookTimestampMs: number;
  bestBid: string | null;
  bestAsk: string | null;
  /** Asks sorted lowest price first (best for a BUY). */
  askLevels: BookLevelStrings[];
  /** Bids sorted highest price first (best for a SELL). */
  bidLevels: BookLevelStrings[];
  tickerTimestampMs: number | null;
  tickerLast: string | null;
}

/** CoinGecko aggregate USDT/INR price (INR-converted; not an Indian venue price). */
export interface CoinGeckoAggregate {
  priceInr: string;
  lastUpdatedAtMs: number;
}

/** One competitor venue's USDT/INR ticker as reported by CoinGecko. */
export interface CompetitorVenue {
  venue: string;
  lastPriceInr: string;
  lastTradedAtMs: number | null;
  fetchedAtMs: number | null;
  volume24h: string | null;
  /** CoinGecko's own staleness flag for this ticker. */
  staleFlag: boolean;
  bidAskSpreadPct: string | null;
}

export interface UsdtMarketSnapshot {
  /** When the attached execution book was fetched (see the live provider). */
  fetchedAtMs: number;
  execution: CoindcxExecution | null;
  executionError: string | null;
  aggregate: CoinGeckoAggregate | null;
  competitors: CompetitorVenue[];
  referenceError: string | null;
  /**
   * True when the CoinDCX fetch failed and the last good reading, still inside
   * the execution freshness window, was served in its place. The service turns
   * it into an `execution_reused_last_good` reason so the UI can say the book
   * is a replayed reading rather than presenting it as a fresh fetch.
   */
  executionReused: boolean;
  /**
   * True when a CoinGecko fetch failed and the last good reference reading,
   * still inside the reference freshness window, was served in its place,
   * tagged `reference_reused_last_good` by the service.
   */
  referenceReused: boolean;
}

export interface UsdtPricingProvider {
  getSnapshot(): Promise<UsdtMarketSnapshot>;
}

/**
 * A provider-level failure: which source failed and why, in a form that is
 * safe to log. Never contains credentials.
 */
export class UsdtProviderError extends Error {
  constructor(
    readonly source: string,
    reason: string,
  ) {
    super(`${source}: ${reason}`);
    this.name = 'UsdtProviderError';
  }
}
