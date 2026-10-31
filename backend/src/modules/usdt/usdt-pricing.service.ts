import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { APP_CONFIG, AppConfig } from '../../config/config.module';
import {
  applyBestPriceGuarantee,
  isWithinSanityBand,
  quoteUsdt,
  roundInr,
  venueExecutablePrice,
  walkBookVwap,
  type BestPriceGuarantee,
  type UsdtOrderSide,
  type UsdtQuote,
  type VenueExecutablePrice,
  type VenuePriceBasis,
} from './domain/usdt-pricing';
import {
  USDT_PRICING_PROVIDER,
  type CompetitorVenue,
  type UsdtMarketSnapshot,
  type UsdtPricingProvider,
} from './providers/usdt-pricing.types';

/**
 * MODULE 08 extension — the pricing policy between raw market data and money.
 *
 * A snapshot becomes a quote through five rules, in order:
 *
 * 1. EXECUTION (BUY walks asks, SELL walks bids) is the volume-weighted
 *    average of the CoinDCX book for the requested quantity, and it counts as
 *    live only while its book timestamp is within `USDT_PRICE_MAX_AGE_MS`
 *    (default 30s) AND the VWAP sits inside the sanity band around the
 *    independent CoinGecko aggregate (or the configured fallback, when the
 *    aggregate is missing). A book that cannot fill the whole quantity is
 *    insufficient depth, not a partial price.
 *
 * 2. BEST-PRICE GUARANTEE: the VWAP is then capped (BUY) or floored (SELL) by
 *    the best executable offer among the same fresh venues - each venue's last
 *    print widened by half of its own reported bid/ask spread - a clear
 *    `MIN_MARKET_ADVANTAGE_INR` (₹1.50) inside it. Zero brokerage says
 *    Prometheus adds nothing; this rule says Prometheus is never merely equal
 *    to the market, it is always at least a rupee and a half better for the
 *    customer. The bound is rounded one paise away from the venue so the
 *    two-decimal figure the API returns cannot give any of that margin back, a
 *    book already further ahead than the margin is left alone, and the whole
 *    result is dropped rather than applied if it would leave the sanity band.
 *
 * 3. REFERENCE comes from fresh CoinGecko venue tickers (stale-flagged or
 *    aged-out venues excluded): two or more venues are labelled an average
 *    with their names, exactly one is labelled a single source, and zero
 *    venues fall back to the CoinGecko aggregate, labelled as an aggregate -
 *    an INR-converted figure, never presented as an Indian venue price. No
 *    fresh reference at all means savings is null, not guessed.
 *
 * 4. FALLBACK is display-only. When execution data is missing, stale or
 *    insane but a configured `USDT_FALLBACK_PRICE_INR` exists, a quote is
 *    served with status `fallback`, the fallback price, and savings null. The
 *    fallback is a configured value, not a market observation.
 *
 * 5. EXECUTION POLICY (the explicit safe rule): a buy or sell settles only
 *    with a live execution VWAP AND a fresh reference - both verified in the
 *    same request. Anything else is HTTP 503 PRICING_UNAVAILABLE: fallback
 *    and stale data never move a wallet, and a customer is never charged a
 *    price that was not shown as live in that same response.
 */
@Injectable()
export class UsdtPricingService {
  private readonly cfg: AppConfig['usdtPricing'];

  constructor(
    @Inject(USDT_PRICING_PROVIDER) private readonly provider: UsdtPricingProvider,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cfg = config.usdtPricing;
  }

  /** Builds a quote view; throws 503 only when no price source at all exists. */
  async quote(side: UsdtOrderSide, usdtAmount: Prisma.Decimal): Promise<UsdtPricingResult> {
    return this.build(side, usdtAmount, false);
  }

  /** Builds the pricing an order must settle at; throws 503 unless fully live. */
  async requireExecution(
    side: UsdtOrderSide,
    usdtAmount: Prisma.Decimal,
  ): Promise<UsdtPricingResult> {
    return this.build(side, usdtAmount, true);
  }

  private async build(
    side: UsdtOrderSide,
    usdtAmount: Prisma.Decimal,
    forExecution: boolean,
  ): Promise<UsdtPricingResult> {
    let snapshot: UsdtMarketSnapshot | null = null;
    try {
      snapshot = await this.provider.getSnapshot();
    } catch {
      // A provider that throws (outage, unparseable payload) is simply an
      // absent snapshot; the fallback and 503 rules below decide what the
      // customer sees. The provider has already logged its own reason.
      snapshot = null;
    }

    const nowMs = Date.now();
    const reasons: string[] = [];

    // Provenance comes first: when a source failed and its last good reading
    // was served instead, that fact is on the record before any verdict which
    // rests on the data, so a replayed figure is never mistaken for a fetch.
    if (snapshot?.executionReused) reasons.push('execution_reused_last_good');
    if (snapshot?.referenceReused) reasons.push('reference_reused_last_good');

    const aggregate = parseAggregate(snapshot?.aggregate ?? null);
    const freshVenues = (snapshot?.competitors ?? []).filter((venue) =>
      isFreshCompetitor(venue, nowMs, this.cfg.referenceMaxAgeMs),
    );

    // Sanity anchor: the independent aggregate, else the configured fallback.
    const fallbackPrice = parseOptionalDecimal(this.cfg.fallbackPriceInr);
    const anchor = aggregate?.price ?? fallbackPrice ?? null;

    const execution = this.resolveExecution(side, usdtAmount, snapshot, nowMs, anchor, reasons);
    const reference = this.resolveReference(freshVenues, aggregate, nowMs, reasons);

    if (execution) {
      if (forExecution && !reference.price) {
        // Approved policy A: an order settles only where its savings can be
        // honestly measured - a recorded order must carry a real reference.
        throw pricingUnavailable(reasons);
      }

      // Every fresh venue priced for this direction: what a customer would
      // actually transact at there, or its raw print where no spread was
      // reported. The same list feeds the guarantee and the comparison table,
      // so the figure Prometheus matches and the figure it displays are one
      // and the same - a guarantee against a number nobody can see is nothing.
      const pricedVenues = freshVenues
        .map((venue) => ({ venue, priced: deriveVenuePrice(side, venue) }))
        .filter((entry): entry is { venue: CompetitorVenue; priced: VenueExecutablePrice } => entry.priced !== null);

      const guarantee = this.applyGuarantee(
        side,
        execution.bookVwap,
        pricedVenues.map((entry) => entry.priced),
        anchor,
        reasons,
      );

      const quote = quoteUsdt(side, usdtAmount, guarantee.price, reference.price);
      return {
        status: 'live',
        quote,
        executionMeta: {
          source: 'coindcx:USDT_INR',
          bookTimestamp: new Date(snapshot?.execution?.bookTimestampMs ?? nowMs).toISOString(),
          fetchedAt: new Date(snapshot?.fetchedAtMs ?? nowMs).toISOString(),
          tickerLast: snapshot?.execution?.tickerLast ?? null,
          bookVwap: execution.bookVwap,
        },
        guarantee,
        referenceBasis: reference.basis,
        competitors: pricedVenues.map((entry) => toCompetitorView(entry.venue, entry.priced)),
        aggregate: aggregate ? toAggregateView(aggregate) : null,
        fallback: null,
        feesNote: 'fees not included',
        reasons,
      };
    }

    if (forExecution) {
      throw pricingUnavailable(reasons);
    }

    if (!fallbackPrice) {
      throw pricingUnavailable([...reasons, 'fallback_not_configured']);
    }

    // Display-only: indicative inrAmount at the configured fallback, with no
    // savings figure and no claim that this is the current market.
    return {
      status: 'fallback',
      quote: {
        side,
        usdtAmount,
        inrAmount: roundInr(usdtAmount.times(fallbackPrice)),
        prometheusPrice: fallbackPrice,
        referencePrice: null,
        savings: null,
      },
      executionMeta: null,
      guarantee: null,
      referenceBasis: null,
      competitors: [],
      aggregate: aggregate ? toAggregateView(aggregate) : null,
      fallback: {
        priceInr: fallbackPrice.toString(),
        note: 'Configured indicative fallback, not live market data. Orders do not execute at this price; verify against a live source before relying on it.',
      },
      feesNote: 'fees not included',
      reasons: [...reasons, 'serving_configured_fallback'],
    };
  }

  /**
   * Rule 2 - the guarantee, with the safety catch that keeps it honest.
   *
   * Moving a price toward the customer can never be a mistake on its own, but
   * the venue it came from is a different source from the anchor the sanity
   * band is drawn around. If the two disagree wildly the venue is the suspect
   * data, so the guarantee is abandoned and the book VWAP stands, with a
   * machine-readable reason saying so rather than a silent exception.
   */
  private applyGuarantee(
    side: UsdtOrderSide,
    bookPrice: Prisma.Decimal,
    venues: readonly VenueExecutablePrice[],
    anchor: Prisma.Decimal | null,
    reasons: string[],
  ): BestPriceGuarantee {
    const guarantee = applyBestPriceGuarantee(side, bookPrice, venues);
    if (!guarantee.applied) return guarantee;

    if (anchor && !isWithinSanityBand(guarantee.price, anchor, this.cfg.sanityMaxDevPct)) {
      reasons.push('best_price_guarantee_out_of_band');
      return { price: bookPrice, applied: false, matchedVenue: null, matchedPrice: null };
    }

    return guarantee;
  }

  private resolveExecution(
    side: UsdtOrderSide,
    usdtAmount: Prisma.Decimal,
    snapshot: UsdtMarketSnapshot | null,
    nowMs: number,
    anchor: Prisma.Decimal | null,
    reasons: string[],
  ): { bookVwap: Prisma.Decimal } | null {
    const execution = snapshot?.execution ?? null;
    if (!execution) {
      reasons.push('execution_unavailable');
      return null;
    }

    const ageMs = nowMs - execution.bookTimestampMs;
    // A book timestamp in the future beyond clock skew is as wrong as an old one.
    if (ageMs < -60_000) {
      reasons.push('execution_timestamp_in_future');
      return null;
    }
    if (ageMs > this.cfg.maxAgeMs) {
      reasons.push('execution_stale');
      return null;
    }

    const levels = side === 'BUY' ? execution.askLevels : execution.bidLevels;
    const { vwap, sufficient } = walkBookVwap(
      levels.map((level) => ({
        price: new Prisma.Decimal(level.price),
        quantity: new Prisma.Decimal(level.quantity),
      })),
      usdtAmount,
    );

    if (!sufficient || !vwap) {
      reasons.push('insufficient_depth');
      return null;
    }

    if (anchor && !isWithinSanityBand(vwap, anchor, this.cfg.sanityMaxDevPct)) {
      reasons.push('sanity_band_exceeded');
      return null;
    }

    // The raw book VWAP is kept alongside the price the customer ends up
    // paying: when the guarantee binds the two differ, and showing only the
    // better one would hide exactly the depth effect the operator needs to see.
    return { bookVwap: vwap };
  }

  private resolveReference(
    freshVenues: CompetitorVenue[],
    aggregate: ParsedAggregate | null,
    _nowMs: number,
    reasons: string[],
  ): { price: Prisma.Decimal | null; basis: string | null } {
    if (freshVenues.length >= 2) {
      const prices = freshVenues.map((venue) => new Prisma.Decimal(venue.lastPriceInr));
      const average = prices.reduce((sum, price) => sum.plus(price), new Prisma.Decimal(0)).div(prices.length);
      const names = freshVenues.map((venue) => venue.venue).join(', ');
      return { price: average, basis: `average_of_${freshVenues.length}_venues(${names})` };
    }

    if (freshVenues.length === 1) {
      const only = freshVenues[0];
      if (only === undefined) {
        reasons.push('reference_unavailable');
        return { price: null, basis: null };
      }
      return {
        price: new Prisma.Decimal(only.lastPriceInr),
        basis: `single_venue(${only.venue})`,
      };
    }

    const aggregateAgeMs = aggregate === null ? null : Date.now() - aggregate.lastUpdatedAtMs;
    if (aggregate && aggregateAgeMs !== null && aggregateAgeMs <= this.cfg.referenceMaxAgeMs) {
      return { price: aggregate.price, basis: 'coingecko_aggregate' };
    }

    reasons.push('reference_unavailable');
    return { price: null, basis: null };
  }
}

/** What one quote cost and what it was measured against. */
export interface UsdtPricingResult {
  status: 'live' | 'fallback';
  quote: UsdtQuote;
  executionMeta: {
    source: 'coindcx:USDT_INR';
    bookTimestamp: string;
    fetchedAt: string;
    tickerLast: string | null;
    /** Raw order-book VWAP for this quantity, before the best-price guarantee. */
    bookVwap: Prisma.Decimal;
  } | null;
  /** The guarantee verdict; null when there was no live market to guarantee against. */
  guarantee: BestPriceGuarantee | null;
  /** e.g. `average_of_3_venues(WazirX, ZebPay, CoinDCX)`, `single_venue(WazirX)`, `coingecko_aggregate`. */
  referenceBasis: string | null;
  competitors: UsdtCompetitorView[];
  aggregate: UsdtAggregateView | null;
  fallback: { priceInr: string; note: string } | null;
  feesNote: 'fees not included';
  reasons: string[];
}

export interface UsdtCompetitorView {
  venue: string;
  lastPrice: string;
  /**
   * What a customer would transact at on this venue for the quoted side: the
   * ask on a BUY, the bid on a SELL, both widened by half the venue's own
   * reported spread. Falls back to `lastPrice` where no spread is reported -
   * see {@link venuePriceBasis}. This, not `lastPrice`, is the figure the
   * guarantee matches and the page compares against.
   */
  venuePrice: string;
  venuePriceBasis: VenuePriceBasis;
  lastTradedAt: string | null;
  volume24h: string | null;
  bidAskSpreadPct: string | null;
}

export interface UsdtAggregateView {
  priceInr: string;
  lastUpdatedAt: string;
  note: string;
}

/** Internal aggregate shape: validated price plus both timestamp forms. */
interface ParsedAggregate {
  price: Prisma.Decimal;
  lastUpdatedAt: string;
  lastUpdatedAtMs: number;
}

function toCompetitorView(venue: CompetitorVenue, priced: VenueExecutablePrice): UsdtCompetitorView {
  return {
    venue: venue.venue,
    lastPrice: venue.lastPriceInr,
    venuePrice: priced.price.toString(),
    venuePriceBasis: priced.basis,
    lastTradedAt: venue.lastTradedAtMs === null ? null : new Date(venue.lastTradedAtMs).toISOString(),
    volume24h: venue.volume24h,
    bidAskSpreadPct: venue.bidAskSpreadPct,
  };
}

/**
 * One venue priced for the quoted direction, or null when its own last price
 * cannot be read as a positive decimal - a figure that cannot be parsed is not
 * offered to the guarantee, and it is not shown in the table either.
 */
function deriveVenuePrice(side: UsdtOrderSide, venue: CompetitorVenue): VenueExecutablePrice | null {
  const lastPrice = parseOptionalDecimal(venue.lastPriceInr);
  if (lastPrice === null) return null;
  return venueExecutablePrice(side, venue.venue, lastPrice, parseOptionalSpread(venue.bidAskSpreadPct));
}

function parseAggregate(raw: { priceInr: string; lastUpdatedAtMs: number } | null): ParsedAggregate | null {
  const price = parseOptionalDecimal(raw?.priceInr ?? null);
  if (!price || raw === null) return null;
  return {
    price,
    lastUpdatedAt: new Date(raw.lastUpdatedAtMs).toISOString(),
    lastUpdatedAtMs: raw.lastUpdatedAtMs,
  };
}

function toAggregateView(aggregate: ParsedAggregate): UsdtAggregateView {
  return {
    priceInr: aggregate.price.toString(),
    lastUpdatedAt: aggregate.lastUpdatedAt,
    note: 'CoinGecko INR-converted aggregate for tether; not an Indian exchange venue price.',
  };
}

function isFreshCompetitor(venue: CompetitorVenue, nowMs: number, referenceMaxAgeMs: number): boolean {
  if (venue.staleFlag) return false;
  if (venue.fetchedAtMs === null) return false;
  const ageMs = nowMs - venue.fetchedAtMs;
  return ageMs >= -60_000 && ageMs <= referenceMaxAgeMs;
}

function parseOptionalDecimal(value: string | null): Prisma.Decimal | null {
  if (value === null || value.trim() === '') return null;
  try {
    const parsed = new Prisma.Decimal(value);
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A bid/ask spread may legitimately be exactly zero - a venue can quote a
 * one-sided or locked market - so, unlike a price, zero parses here rather
 * than falling through to "no spread reported".
 */
function parseOptionalSpread(value: string | null): Prisma.Decimal | null {
  if (value === null || value.trim() === '') return null;
  try {
    const parsed = new Prisma.Decimal(value);
    return parsed.isFinite() && parsed.gte(0) ? parsed : null;
  } catch {
    return null;
  }
}

function pricingUnavailable(reasons: string[]): DomainException {
  return new DomainException(
    ERROR_CODES.PRICING_UNAVAILABLE,
    'Live USDT pricing is unavailable, so no order may be executed at a fresh market price. Retry shortly or quote again.',
    HttpStatus.SERVICE_UNAVAILABLE,
    reasons,
  );
}
