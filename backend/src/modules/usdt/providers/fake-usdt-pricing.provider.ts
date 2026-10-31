import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, AppConfig } from '../../../config/config.module';
import {
  UsdtProviderError,
  type CoindcxExecution,
  type UsdtMarketSnapshot,
  type UsdtPricingProvider,
} from './usdt-pricing.types';

/**
 * MODULE 08 extension — the deterministic, programmable USDT pricing provider.
 *
 * WHY IT EXISTS. The automated suites must assert byte-identical settlement
 * amounts, exercise the stale/fallback/503 policies, and never touch the
 * network. This provider answers with a fixed, believable USDT/INR market -
 * asks at 100.10/100.20, bids at 99.90/99.80, three competitors at
 * 100.25/100.20/100.15 -
 * whose numbers were chosen so a 1,000 USDT BUY walks a book VWAP of 100.10
 * and settles at the guaranteed 98.66, i.e. exactly 98,660.00 INR, with
 * savings against the 100.20 competitor average of exactly 1,540.00 INR.
 * These are invented prices, clearly labelled by the provider name; nothing
 * here is a market observation.
 *
 * PROGRAMMABLE VIA `USDT_FAKE_PRICING_SCENARIO` (read per call, so a test can
 * flip it mid-suite): `live` (default), `stale` (timestamps far in the past,
 * so the freshness rules reject the data), `down` (the provider throws, as a
 * network outage would) and `no-reference` (execution data only, so savings
 * must come back null and orders must refuse with PRICING_UNAVAILABLE).
 */
@Injectable()
export class FakeUsdtPricingProvider implements UsdtPricingProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  getSnapshot(): Promise<UsdtMarketSnapshot> {
    const scenario = process.env['USDT_FAKE_PRICING_SCENARIO'] ?? this.config.usdtPricing.fakeScenario;

    if (scenario === 'down') {
      return Promise.reject(new UsdtProviderError('coindcx_orderbook', 'simulated provider outage'));
    }

    const nowMs = Date.now();
    // `stale` ages every timestamp past both the 30s execution window and the
    // reference window, so nothing about the snapshot may be treated as live.
    const stampMs = scenario === 'stale' ? nowMs - 1_000_000 : nowMs;

    return Promise.resolve({
      fetchedAtMs: nowMs,
      execution: fakeExecution(stampMs),
      executionError: null,
      executionReused: false,
      aggregate:
        scenario === 'no-reference'
          ? null
          : { priceInr: '100.1', lastUpdatedAtMs: stampMs },
      competitors:
        scenario === 'no-reference'
          ? []
          : [
              {
                venue: 'AlphaExchange',
                lastPriceInr: '100.25',
                lastTradedAtMs: stampMs,
                fetchedAtMs: stampMs,
                volume24h: '1234.5',
                staleFlag: false,
                bidAskSpreadPct: '0.02',
              },
              {
                venue: 'BetaExchange',
                lastPriceInr: '100.15',
                lastTradedAtMs: stampMs,
                fetchedAtMs: stampMs,
                volume24h: '987.6',
                staleFlag: false,
                bidAskSpreadPct: '0.03',
              },
              // Third comparison venue, so the exchange screen always carries a
              // three-row table to read Prometheus against. Its print sits
              // exactly on the 100.20 average of the other two, so adding it
              // changes the reference - and therefore every settled figure - by
              // nothing at all, while its own executable price stays between
              // Alpha's and Beta's and so never becomes the bound.
              {
                venue: 'GammaExchange',
                lastPriceInr: '100.20',
                lastTradedAtMs: stampMs,
                fetchedAtMs: stampMs,
                volume24h: '1500.0',
                staleFlag: false,
                bidAskSpreadPct: '0.02',
              },
            ],
      referenceError: null,
      referenceReused: false,
    });
  }
}

function fakeExecution(stampMs: number): CoindcxExecution {
  return {
    bookTimestampMs: stampMs,
    bestBid: '99.9',
    bestAsk: '100.1',
    askLevels: [
      { price: '100.1', quantity: '5000' },
      { price: '100.2', quantity: '5000' },
    ],
    bidLevels: [
      { price: '99.9', quantity: '5000' },
      { price: '99.8', quantity: '5000' },
    ],
    tickerTimestampMs: Math.floor(stampMs / 1000),
    tickerLast: '100',
  };
}
