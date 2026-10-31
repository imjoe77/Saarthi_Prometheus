import { Prisma } from '@prisma/client';
import { HttpStatus } from '@nestjs/common';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { AppConfig, UsdtPricingConfig } from '../../config/app.config';
import { UsdtPricingService } from './usdt-pricing.service';
import {
  type CoinGeckoAggregate,
  type CoindcxExecution,
  type CompetitorVenue,
  type UsdtMarketSnapshot,
  type UsdtPricingProvider,
} from './providers/usdt-pricing.types';

/**
 * MODULE 08 extension — the policy layer that decides whether money may move
 * and at what price. Every scenario from the approved design is provoked with
 * a stub provider so the assertions are exact: the deterministic fake market
 * (asks 100.1/100.2, bids 99.9/99.8, competitors Alpha 100.25 / Beta 100.15,
 * aggregate 100.1) plus the degraded shapes that must refuse to execute.
 */

const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

class StubProvider implements UsdtPricingProvider {
  constructor(private readonly handler: () => UsdtMarketSnapshot | Promise<UsdtMarketSnapshot>) {}

  getSnapshot(): Promise<UsdtMarketSnapshot> {
    try {
      return Promise.resolve(this.handler());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function execution(nowMs: number): CoindcxExecution {
  return {
    bookTimestampMs: nowMs,
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
    tickerTimestampMs: Math.floor(nowMs / 1000),
    tickerLast: '100',
  };
}

function venue(overrides: Partial<CompetitorVenue> = {}): CompetitorVenue {
  return {
    venue: 'AlphaExchange',
    lastPriceInr: '100.25',
    lastTradedAtMs: Date.now(),
    fetchedAtMs: Date.now(),
    volume24h: '1234.5',
    staleFlag: false,
    bidAskSpreadPct: '0.02',
    ...overrides,
  };
}

function snapshot(overrides: Partial<UsdtMarketSnapshot> = {}): UsdtMarketSnapshot {
  const nowMs = Date.now();
  return {
    fetchedAtMs: nowMs,
    execution: execution(nowMs),
    executionError: null,
    executionReused: false,
    aggregate: { priceInr: '100.1', lastUpdatedAtMs: nowMs } satisfies CoinGeckoAggregate,
    competitors: [
      venue(),
      venue({ venue: 'BetaExchange', lastPriceInr: '100.15', bidAskSpreadPct: '0.03' }),
      // Third venue on the same print as the two-venue average, so the table
      // has three rows to compare against without moving the reference.
      venue({ venue: 'GammaExchange', lastPriceInr: '100.20', volume24h: '1500.0' }),
    ],
    referenceError: null,
    referenceReused: false,
    ...overrides,
  };
}

function service(provider: UsdtPricingProvider, fallbackPriceInr: string | null = '99.90'): UsdtPricingService {
  return new UsdtPricingService(
    provider,
    new AppConfig({ usdtPricing: new UsdtPricingConfig({ provider: 'fake', fallbackPriceInr }) }),
  );
}

function stub(handler: () => UsdtMarketSnapshot | Promise<UsdtMarketSnapshot>): UsdtPricingService {
  return service(new StubProvider(handler));
}

async function expectRefusal(run: () => Promise<unknown>): Promise<DomainException> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainException) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('UsdtPricingService', () => {
  describe('a live market', () => {
    it('prices a BUY a clear ₹1.50 under the cheapest venue, with the book published alongside', async () => {
      const result = await stub(() => snapshot()).quote('BUY', dec('10000'));

      expect(result.status).toBe('live');
      // (5000 x 100.1 + 5000 x 100.2) / 10000 = 100.15
      expect(result.executionMeta?.bookVwap.toString()).toBe('100.15');
      // Cheapest ask on screen: Beta 100.15 x 1.00015 = 100.1650225, a clear
      // ₹1.50 inside it is 98.6650225, floored to 98.66 - so Prometheus is a
      // rupee and a half under the market rather than a paisa under it.
      expect(result.guarantee?.applied).toBe(true);
      expect(result.guarantee?.matchedVenue).toBe('BetaExchange');
      expect(result.guarantee?.matchedPrice?.toString()).toBe('100.1650225');
      expect(result.quote.prometheusPrice.toString()).toBe('98.66');
      expect(result.quote.inrAmount.toString()).toBe('986600');
      // Reference: average(100.25, 100.20, 100.15) = 100.20;
      // 10000 x (100.20 - 98.66).
      expect(result.quote.referencePrice?.toString()).toBe('100.2');
      expect(result.quote.savings?.toString()).toBe('15400');
      expect(result.referenceBasis).toBe(
        'average_of_3_venues(AlphaExchange, BetaExchange, GammaExchange)',
      );
      expect(result.competitors.map((entry) => entry.venue)).toEqual([
        'AlphaExchange',
        'BetaExchange',
        'GammaExchange',
      ]);
      // Each venue is published at what a buyer would actually pay there, not
      // at its last print - that is the figure the guarantee measured against.
      // Gamma's 100.20 x 1.0001 = 100.21002 sits between the other two, so
      // Beta's 100.1650225 remains the bound the BUY was capped against.
      expect(result.competitors.map((entry) => entry.venuePrice)).toEqual([
        '100.260025',
        '100.1650225',
        '100.21002',
      ]);
      expect(result.competitors.map((entry) => entry.venuePriceBasis)).toEqual([
        'derived_from_spread',
        'derived_from_spread',
        'derived_from_spread',
      ]);
      expect(result.aggregate?.priceInr).toBe('100.1');
      expect(result.fallback).toBeNull();
      expect(result.executionMeta?.source).toBe('coindcx:USDT_INR');
      expect(result.reasons).toEqual([]);
    });

    it('prices a SELL a clear ₹1.50 above the best venue bid', async () => {
      const result = await stub(() => snapshot()).quote('SELL', dec('10000'));

      // Raw book VWAP: (5000 x 99.9 + 5000 x 99.8) / 10000 = 99.85.
      expect(result.executionMeta?.bookVwap.toString()).toBe('99.85');

      // The venues sell at their bids, i.e. their print widened down by half
      // their own spread: Alpha 100.25 - 0.01% = 100.239975, Beta 100.15 -
      // 0.015% = 100.13497... The best is Alpha, plus ₹1.50 = 101.739975,
      // ceiled to the paise so the gap never dips under the margin = 101.74.
      expect(result.guarantee?.applied).toBe(true);
      expect(result.guarantee?.matchedVenue).toBe('AlphaExchange');
      expect(result.guarantee?.matchedPrice?.toString()).toBe('100.239975');
      expect(result.quote.prometheusPrice.toString()).toBe('101.74');
      expect(result.quote.inrAmount.toString()).toBe('1017400');
      // 10000 x (101.74 - 100.20) = 15400: better than the reference, because
      // a SELL guarantee can only ever move the price upward.
      expect(result.quote.savings?.toString()).toBe('15400');
    });

    it('settles an order only at the live, guaranteed price, with the same figures', async () => {
      const result = await stub(() => snapshot()).requireExecution('BUY', dec('100'));

      expect(result.status).toBe('live');
      // Book (100 x 100.1) / 100 = 100.1, guaranteed to 98.66; savings
      // 100 x (100.20 - 98.66) = 154.
      expect(result.executionMeta?.bookVwap.toString()).toBe('100.1');
      expect(result.quote.inrAmount.toString()).toBe('9866');
      expect(result.quote.savings?.toString()).toBe('154');
    });
  });

  describe('the best-price guarantee (Prometheus is always a clear ₹1.50 inside the market)', () => {
    it('caps a BUY the margin below the cheapest venue ask, rounded so the 2-decimal figure keeps it', async () => {
      const result = await stub(() =>
        snapshot({
          execution: {
            ...execution(Date.now()),
            // A book far above every venue: asks at 101.00, i.e. no cheap level.
            askLevels: [{ price: '101', quantity: '10000' }],
            bidLevels: [{ price: '100.8', quantity: '10000' }],
          },
        }),
      ).quote('BUY', dec('10'));

      // Cheapest ask on screen: Beta 100.15 x 1.00015 = 100.1650225 - 1.50,
      // floored to 98.66.
      expect(result.guarantee?.applied).toBe(true);
      expect(result.guarantee?.matchedVenue).toBe('BetaExchange');
      expect(result.guarantee?.matchedPrice?.toString()).toBe('100.1650225');
      expect(result.quote.prometheusPrice.toString()).toBe('98.66');
      // At least the margin inside every venue the page will print, by
      // construction.
      for (const competitor of result.competitors) {
        const gap = new Prisma.Decimal(competitor.venuePrice).minus(result.quote.prometheusPrice);
        expect(gap.gte(new Prisma.Decimal('1.50'))).toBe(true);
      }
      // The raw book is still published so the giving-away is visible.
      expect(result.executionMeta?.bookVwap.toString()).toBe('101');
      expect(result.reasons).toEqual([]);
    });

    it('leaves a BUY alone once the book is already more than the margin better, and never worsens a price', async () => {
      const result = await stub(() =>
        snapshot({
          execution: {
            ...execution(Date.now()),
            // 98.5 against a cheapest ask of 100.1650225: 1.665 of advantage,
            // already past the promised ₹1.50, so the bound does not bind.
            askLevels: [{ price: '98.5', quantity: '10000' }],
            bidLevels: [{ price: '98.3', quantity: '10000' }],
          },
        }),
      ).quote('BUY', dec('10'));

      expect(result.executionMeta?.bookVwap.toString()).toBe('98.5');
      expect(result.guarantee?.applied).toBe(false);
      expect(result.quote.prometheusPrice.toString()).toBe('98.5');
    });

    it('is abandoned rather than applied when it would leave the sanity band', async () => {
      const result = await stub(() =>
        snapshot({
          // The anchor (aggregate) is 100.1, so a venue priced at 40.00 is
          // bad data, not a bargain. Capping there would move money on a
          // figure the independent source contradicts.
          competitors: [venue({ venue: 'BrokenVenue', lastPriceInr: '40', bidAskSpreadPct: '0.02' })],
        }),
      ).quote('BUY', dec('10'));

      expect(result.guarantee?.applied).toBe(false);
      expect(result.quote.prometheusPrice.toString()).toBe('100.1');
      expect(result.reasons).toContain('best_price_guarantee_out_of_band');
    });

    it('reports no guarantee at all when there is no live market to guarantee against', async () => {
      const result = await stub(() => snapshot({ execution: null, executionError: 'timeout' })).quote(
        'BUY',
        dec('10'),
      );

      expect(result.status).toBe('fallback');
      expect(result.guarantee).toBeNull();
      expect(result.executionMeta).toBeNull();
    });
  });

  describe('reused upstream readings (transient outage resilience)', () => {
    it('prices normally while labelling the replayed book and reference as reused', async () => {
      const result = await stub(() =>
        snapshot({ executionReused: true, referenceReused: true }),
      ).quote('BUY', dec('10000'));

      expect(result.status).toBe('live');
      // The customer still gets the guaranteed price; what changes is that the
      // payload admits where the data came from instead of pretending the
      // failed upstream answered.
      expect(result.quote.prometheusPrice.toString()).toBe('98.66');
      expect(result.reasons).toEqual(['execution_reused_last_good', 'reference_reused_last_good']);
    });

    it('says nothing when the readings came straight from the source', async () => {
      const result = await stub(() => snapshot()).quote('BUY', dec('10'));

      expect(result.reasons).toEqual([]);
    });
  });

  describe('reference freshness', () => {
    it('labels a sole surviving venue as a single source', async () => {
      const result = await stub(() =>
        snapshot({
          competitors: [venue({ venue: 'WazirX', lastPriceInr: '99.66' })],
        }),
      ).quote('BUY', dec('10'));

      expect(result.referenceBasis).toBe('single_venue(WazirX)');
      expect(result.quote.referencePrice?.toString()).toBe('99.66');
      // The book would have charged 100.1 (first ask level), but WazirX's ask
      // is 99.66 x 1.0001 = 99.669966, less ₹1.50 and floored to 98.16 - so
      // Prometheus is the margin under the only venue on screen, and the
      // customer keeps the difference against that reference: 10 x 1.50 = 15.
      expect(result.executionMeta?.bookVwap.toString()).toBe('100.1');
      expect(result.guarantee?.applied).toBe(true);
      expect(result.quote.prometheusPrice.toString()).toBe('98.16');
      expect(result.quote.savings?.toString()).toBe('15');
    });

    it('excludes stale-flagged venues and falls back to the labelled aggregate', async () => {
      const result = await stub(() =>
        snapshot({
          competitors: [
            venue({ venue: 'BitBNS', lastPriceInr: '76.09', staleFlag: true }),
            venue({ venue: 'WazirX', lastPriceInr: '99.66' }),
          ],
        }),
      ).quote('BUY', dec('10'));

      // Only WazirX survives the freshness filter, so it is a single venue.
      expect(result.referenceBasis).toBe('single_venue(WazirX)');
    });

    it('excludes venues fetched outside the reference window', async () => {
      const result = await stub(() =>
        snapshot({
          competitors: [venue({ fetchedAtMs: Date.now() - 1_000_000 })],
          aggregate: { priceInr: '100.1', lastUpdatedAtMs: Date.now() },
        }),
      ).quote('BUY', dec('10'));

      expect(result.referenceBasis).toBe('coingecko_aggregate');
      expect(result.aggregate?.note).toContain('not an Indian exchange venue price');
    });

    it('falls to the aggregate only while the aggregate itself is fresh', async () => {
      const result = await stub(() =>
        snapshot({
          competitors: [],
          aggregate: { priceInr: '100.1', lastUpdatedAtMs: Date.now() - 1_000_000 },
        }),
      ).quote('BUY', dec('10'));

      expect(result.referenceBasis).toBeNull();
      expect(result.quote.referencePrice).toBeNull();
      expect(result.quote.savings).toBeNull();
      expect(result.reasons).toContain('reference_unavailable');
    });
  });

  describe('execution refusal (policy: an order needs a live VWAP and a fresh reference)', () => {
    it('refuses an execution whose book timestamp is older than the window', async () => {
      const nowMs = Date.now();
      const error = await expectRefusal(() =>
        stub(() =>
          snapshot({ execution: { ...execution(nowMs), bookTimestampMs: nowMs - 60_000 } }),
        ).requireExecution('BUY', dec('10')),
      );

      expect(error.code).toBe(ERROR_CODES.PRICING_UNAVAILABLE);
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.details).toContain('execution_stale');
    });

    it('refuses a book timestamp far in the future', async () => {
      const nowMs = Date.now();
      const error = await expectRefusal(() =>
        stub(() =>
          snapshot({ execution: { ...execution(nowMs), bookTimestampMs: nowMs + 120_000 } }),
        ).requireExecution('BUY', dec('10')),
      );

      expect(error.details).toContain('execution_timestamp_in_future');
    });

    it('refuses when the book cannot fill the quantity', async () => {
      const error = await expectRefusal(() =>
        stub(() => snapshot()).requireExecution('BUY', dec('20000')),
      );

      expect(error.details).toContain('insufficient_depth');
    });

    it('refuses a VWAP outside the sanity band around the independent anchor', async () => {
      const nowMs = Date.now();
      const error = await expectRefusal(() =>
        stub(() =>
          snapshot({
            execution: {
              ...execution(nowMs),
              askLevels: [{ price: '150', quantity: '10000' }],
              bidLevels: [{ price: '149', quantity: '10000' }],
            },
          }),
        ).requireExecution('BUY', dec('10')),
      );

      // 150 vs aggregate 100.1 is ~50% away - far beyond the 20% default band.
      expect(error.details).toContain('sanity_band_exceeded');
    });

    it('refuses an order with execution data but no fresh reference at all', async () => {
      const error = await expectRefusal(() =>
        stub(() =>
          snapshot({
            competitors: [],
            aggregate: { priceInr: '100.1', lastUpdatedAtMs: Date.now() - 1_000_000 },
          }),
        ).requireExecution('BUY', dec('10')),
      );

      expect(error.code).toBe(ERROR_CODES.PRICING_UNAVAILABLE);
      expect(error.details).toContain('reference_unavailable');
    });

    it('refuses when the provider throws outright', async () => {
      const error = await expectRefusal(() =>
        stub(() => {
          throw new Error('network unreachable');
        }).requireExecution('SELL', dec('10')),
      );

      expect(error.code).toBe(ERROR_CODES.PRICING_UNAVAILABLE);
    });
  });

  describe('the display-only fallback', () => {
    it('serves a labelled quote with null savings when execution data is missing', async () => {
      const result = await stub(() => snapshot({ execution: null, executionError: 'timeout' })).quote(
        'BUY',
        dec('10000'),
      );

      expect(result.status).toBe('fallback');
      // 10000 x 99.90 - the configured figure, not a market observation.
      expect(result.quote.inrAmount.toString()).toBe('999000');
      expect(result.quote.prometheusPrice.toString()).toBe('99.9');
      expect(result.quote.referencePrice).toBeNull();
      expect(result.quote.savings).toBeNull();
      expect(result.fallback?.priceInr).toBe('99.9');
      expect(result.fallback?.note).toContain('not live market data');
      expect(result.executionMeta).toBeNull();
      expect(result.reasons).toContain('execution_unavailable');
      expect(result.reasons).toContain('serving_configured_fallback');
    });

    it('serves the fallback for a stale book too, but never executes it', async () => {
      const nowMs = Date.now();
      const service_ = stub(() =>
        snapshot({ execution: { ...execution(nowMs), bookTimestampMs: nowMs - 60_000 } }),
      );

      const quoted = await service_.quote('BUY', dec('10'));
      expect(quoted.status).toBe('fallback');

      const error = await expectRefusal(() => service_.requireExecution('BUY', dec('10')));
      expect(error.code).toBe(ERROR_CODES.PRICING_UNAVAILABLE);
      expect(error.details).toContain('execution_stale');
    });

    it('is not invented when nothing is configured', async () => {
      const service_ = service(new StubProvider(() => snapshot({ execution: null })), null);

      const error = await expectRefusal(() => service_.quote('BUY', dec('10')));
      expect(error.code).toBe(ERROR_CODES.PRICING_UNAVAILABLE);
      expect(error.details).toContain('fallback_not_configured');
    });
  });
});
