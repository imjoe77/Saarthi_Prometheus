import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, AppConfig } from '../../../config/config.module';
import { fetchCoinGeckoAggregate, fetchCoinGeckoVenues } from './coingecko-market-data';
import { fetchCoindcxExecution } from './coindcx-market-data';
import type {
  CoinGeckoAggregate,
  CoindcxExecution,
  CompetitorVenue,
  UsdtMarketSnapshot,
  UsdtPricingProvider,
} from './usdt-pricing.types';

/**
 * MODULE 08 extension — the live CoinDCX + CoinGecko provider.
 *
 * One pass fetches the CoinDCX execution book and the CoinGecko aggregate and
 * venue tickers concurrently. Each source fails independently: a CoinGecko
 * outage leaves the execution book usable (quotes lose their savings figure
 * but orders can still price), and a CoinDCX outage leaves the reference data
 * intact (the quote becomes a labelled fallback). Failures are recorded as
 * short, credential-free labels - never as swallowed successes.
 *
 * LAST GOOD READING (transient-upstream resilience). A single failed pass used
 * to drop the whole page to the empty fallback even though the market had only
 * blinked. When a fetch fails, the last good reading for that source is served
 * instead - but only while it is still inside the same freshness window the
 * service enforces anyway (`USDT_PRICE_MAX_AGE_MS` for the book,
 * `USDT_REFERENCE_MAX_AGE_MS` for the reference), so a reused figure can never
 * be older than a fetched one could be. The snapshot carries
 * `executionReused` / `referenceReused` flags, which the service turns into
 * machine-readable reasons: a replayed reading is labelled, never passed off
 * as a fresh fetch.
 *
 * Snapshots are cached in memory for `USDT_PRICE_CACHE_TTL_MS` (default 5s):
 * CoinGecko's demo tier allows tens of requests per minute, and every quote
 * from every browser tab is a request. The cache is a single entry, not a map
 * - there is one pair, and unbounded caching is how a stale price survives.
 */
@Injectable()
export class LiveUsdtPricingProvider implements UsdtPricingProvider {
  private readonly logger = new Logger(LiveUsdtPricingProvider.name);

  private cached: { atMs: number; snapshot: UsdtMarketSnapshot } | null = null;

  /** Last successful CoinDCX book, kept so one failed pass can reuse it. */
  private lastGoodExecution: { atMs: number; execution: CoindcxExecution } | null = null;

  /** Last successful CoinGecko aggregate, reused on a failed aggregate fetch. */
  private lastGoodAggregate: { atMs: number; aggregate: CoinGeckoAggregate } | null = null;

  /** Last successful CoinGecko venue list, reused on a failed venue fetch. */
  private lastGoodVenues: { atMs: number; competitors: CompetitorVenue[] } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getSnapshot(): Promise<UsdtMarketSnapshot> {
    const nowMs = Date.now();

    if (this.cached && nowMs - this.cached.atMs < this.config.usdtPricing.cacheTtlMs) {
      return this.cached.snapshot;
    }

    const snapshot = await this.fetchSnapshot(nowMs);
    this.cached = { atMs: nowMs, snapshot };
    return snapshot;
  }

  private async fetchSnapshot(nowMs: number): Promise<UsdtMarketSnapshot> {
    const cfg = this.config.usdtPricing;

    const [executionResult, aggregateResult, venuesResult] = await Promise.allSettled([
      fetchCoindcxExecution({
        tickerUrl: cfg.coindcxTickerUrl,
        orderbookUrl: cfg.coindcxOrderbookUrl,
        timeoutMs: cfg.fetchTimeoutMs,
      }),
      fetchCoinGeckoAggregate({
        baseUrl: cfg.coinGeckoBaseUrl,
        apiKey: cfg.coinGeckoApiKey,
        timeoutMs: cfg.fetchTimeoutMs,
      }),
      fetchCoinGeckoVenues({
        baseUrl: cfg.coinGeckoBaseUrl,
        apiKey: cfg.coinGeckoApiKey,
        timeoutMs: cfg.fetchTimeoutMs,
      }),
    ]);

    const executionError = reasonOf(executionResult);
    const aggregateError = reasonOf(aggregateResult);
    const venuesError = reasonOf(venuesResult);

    if (executionError) this.logger.warn(`CoinDCX execution data unavailable: ${executionError}`);
    if (aggregateError || venuesError) {
      this.logger.warn(`CoinGecko reference data unavailable: ${aggregateError ?? ''} ${venuesError ?? ''}`.trim());
    }

    // Execution: fresh fetch wins and refreshes the last good reading; a failed
    // fetch falls back to it while the reading is still inside the book window.
    let execution: CoindcxExecution | null = null;
    let executionReused = false;
    let executionFetchedAtMs = nowMs;
    if (executionResult.status === 'fulfilled') {
      execution = executionResult.value;
      this.lastGoodExecution = { atMs: nowMs, execution };
    } else if (this.lastGoodExecution && nowMs - this.lastGoodExecution.atMs <= cfg.maxAgeMs) {
      execution = this.lastGoodExecution.execution;
      executionReused = true;
      // The attached book was fetched then, not now - the UI's "book captured"
      // figure must keep telling the truth about how old the reading is.
      executionFetchedAtMs = this.lastGoodExecution.atMs;
      this.logger.warn(`CoinDCX fetch failed; reusing the last good book (${executionFetchedAtMs}).`);
    }

    // Reference: the aggregate and the venue list are reused independently, so
    // one failing half never throws away the other half's fresh reading. Each
    // half falls back to its own last good value while that value is still
    // inside the reference window, and the snapshot says which was replayed.
    let aggregate: CoinGeckoAggregate | null = null;
    let aggregateReused = false;
    if (aggregateResult.status === 'fulfilled') {
      aggregate = aggregateResult.value;
      this.lastGoodAggregate = { atMs: nowMs, aggregate };
    } else if (this.lastGoodAggregate && nowMs - this.lastGoodAggregate.atMs <= cfg.referenceMaxAgeMs) {
      aggregate = this.lastGoodAggregate.aggregate;
      aggregateReused = true;
      this.logger.warn(`CoinGecko aggregate failed; reusing the last good reading (${this.lastGoodAggregate.atMs}).`);
    }

    let competitors: CompetitorVenue[] = [];
    let venuesReused = false;
    if (venuesResult.status === 'fulfilled') {
      competitors = venuesResult.value;
      this.lastGoodVenues = { atMs: nowMs, competitors };
    } else if (this.lastGoodVenues && nowMs - this.lastGoodVenues.atMs <= cfg.referenceMaxAgeMs) {
      competitors = this.lastGoodVenues.competitors;
      venuesReused = true;
      this.logger.warn(`CoinGecko venues failed; reusing the last good list (${this.lastGoodVenues.atMs}).`);
    }

    return {
      fetchedAtMs: executionReused ? executionFetchedAtMs : nowMs,
      execution,
      executionError,
      executionReused,
      aggregate,
      competitors,
      referenceError: [aggregateError, venuesError].filter(Boolean).join('; ') || null,
      referenceReused: aggregateReused || venuesReused,
    };
  }
}

function reasonOf(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') return null;
  return result.reason instanceof Error ? result.reason.message : 'unknown provider error';
}
