import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { formatDecimal } from '../../wallet/decimal.util';
import {
  INR_DECIMALS,
  MIN_MARKET_ADVANTAGE_INR,
  type BestPriceGuarantee,
  type UsdtOrderSide,
} from '../domain/usdt-pricing';
import type { UsdtPricingResult } from '../usdt-pricing.service';

/**
 * MODULE 08 extension — pricing metadata attached to quote and order-creation
 * responses.
 *
 * Every figure here is either a raw market observation or explicitly labelled
 * as something else: the execution book is `coindcx:USDT_INR`, each competitor
 * carries its venue name and last-trade time, the aggregate says in its own
 * `note` that it is an INR-converted figure rather than an Indian venue
 * price, and a fallback identifies itself as configured and indicative. The
 * `feesNote` exists because no provider reported a fee for this pair: raw
 * prices are shown, estimated competitor fees never are.
 *
 * Two fields exist so the best-price guarantee can be audited rather than
 * trusted: `execution.bookVwap` is what the raw book said, `guarantee` is what
 * changed and why, and each competitor's `venuePrice` is the exact figure the
 * guarantee measured itself against. When nothing changed, all three say so.
 */
export class UsdtCompetitorPriceDto {
  @ApiProperty({ description: 'Competitor venue name as reported by CoinGecko.', example: 'WazirX' })
  venue!: string;

  @ApiProperty({ description: 'Raw last USDT/INR price on this venue (no fees applied).', example: '99.66' })
  lastPrice!: string;

  @ApiProperty({
    description:
      'What a customer would transact at on this venue for the quoted side: the ask on a BUY, the bid on a SELL, widened by half the venue bid/ask spread. Equals lastPrice when no spread was reported - see venuePriceBasis.',
    example: '99.67',
  })
  venuePrice!: string;

  @ApiProperty({
    description:
      'How venuePrice was obtained: derived_from_spread (half of the reported bid/ask spread applied to lastPrice) or last_price (no spread reported, so the raw print is used as the best case for this venue).',
    enum: ['derived_from_spread', 'last_price'],
  })
  venuePriceBasis!: 'derived_from_spread' | 'last_price';

  @ApiProperty({ description: 'When this venue last traded, ISO-8601, or null.', example: '2026-10-14T11:24:00.000Z' })
  lastTradedAt!: string | null;

  @ApiPropertyOptional({ description: '24h volume as reported, or null.', example: '298796.25' })
  volume24h!: string | null;

  @ApiPropertyOptional({ description: 'Provider-reported bid/ask spread percent, or null when not reported.', example: '0.52' })
  bidAskSpreadPct!: string | null;
}

export class UsdtGuaranteeDto {
  @ApiProperty({
    description:
      'True when the book was not already a clear minimum advantage better than every venue, so the price moved toward the customer.',
  })
  applied!: boolean;

  @ApiPropertyOptional({
    description: 'Venue whose offer the price was measured against; null when the book already held the advantage.',
    example: 'WazirX',
  })
  matchedVenue!: string | null;

  @ApiPropertyOptional({
    description:
      "That venue's executable offer before the minimum advantage and the paise rounding; null when not applied.",
    example: '99.67',
  })
  matchedPrice!: string | null;

  @ApiProperty({
    description: 'Plain-language statement of what the guarantee did on this quote.',
    example: 'Order-book VWAP capped to at least 1.50 below the best venue offer (WazirX 99.67) and settled at 98.17.',
  })
  note!: string;
}

export class UsdtAggregatePriceDto {
  @ApiProperty({ description: 'CoinGecko INR aggregate price for tether.', example: '94.98' })
  priceInr!: string;

  @ApiProperty({ description: 'When CoinGecko last updated this figure, ISO-8601.', example: '2026-10-14T11:20:20.000Z' })
  lastUpdatedAt!: string;

  @ApiProperty({
    description: 'Labels the figure honestly: an INR-converted aggregate, not an Indian exchange venue price.',
  })
  note!: string;
}

export class UsdtFallbackPriceDto {
  @ApiProperty({ description: 'Configured indicative price, INR per USDT.', example: '99.9' })
  priceInr!: string;

  @ApiProperty({
    description: 'What this figure is and is not; orders never execute at it.',
  })
  note!: string;
}

export class UsdtExecutionMetaDto {
  @ApiProperty({ description: 'Execution price source.', example: 'coindcx:USDT_INR' })
  source!: string;

  @ApiProperty({ description: 'CoinDCX order-book timestamp, ISO-8601.', example: '2026-10-14T11:24:03.000Z' })
  bookTimestamp!: string;

  @ApiProperty({ description: 'When this backend fetched the snapshot, ISO-8601.', example: '2026-10-14T11:24:03.500Z' })
  fetchedAt!: string;

  @ApiPropertyOptional({ description: 'CoinDCX ticker last price when available, else null.', example: '99.9' })
  tickerLast!: string | null;

  @ApiProperty({
    description:
      'Raw order-book VWAP for this quantity, before the best-price guarantee. Equals the charged price when the guarantee did not bind; the spread between the two is exactly what the guarantee gave back.',
    example: '100.15',
  })
  bookVwap!: string;
}

export class UsdtPricingMetadataDto {
  @ApiProperty({ description: 'live = fresh market data; fallback = configured indicative display only.', enum: ['live', 'fallback'] })
  status!: 'live' | 'fallback';

  @ApiPropertyOptional({ type: UsdtExecutionMetaDto, description: 'Execution book metadata; null on fallback.' })
  execution!: UsdtExecutionMetaDto | null;

  @ApiPropertyOptional({
    type: UsdtGuaranteeDto,
    description:
      'The best-price guarantee verdict for this quote; null on fallback, where there is no live market to guarantee against.',
  })
  guarantee!: UsdtGuaranteeDto | null;

  @ApiPropertyOptional({
    description:
      'How the savings reference was derived: average_of_N_venues(...), single_venue(...) or coingecko_aggregate; null when no fresh reference existed.',
    example: 'average_of_3_venues(WazirX, ZebPay, CoinDCX)',
  })
  referenceBasis!: string | null;

  @ApiProperty({
    type: [UsdtCompetitorPriceDto],
    description:
      'Fresh comparable venue prices (stale venues excluded). Every fresh venue is listed, so the exchange screen can show the full side-by-side comparison - three or more rows whenever that many venues reported a price - and the same list is what the best-price guarantee measured against.',
  })
  competitors!: UsdtCompetitorPriceDto[];

  @ApiPropertyOptional({ type: UsdtAggregatePriceDto, description: 'CoinGecko aggregate, when available.' })
  aggregate!: UsdtAggregatePriceDto | null;

  @ApiPropertyOptional({ type: UsdtFallbackPriceDto, description: 'Present only when status is fallback.' })
  fallback!: UsdtFallbackPriceDto | null;

  @ApiProperty({ description: 'Raw prices only - no provider reported a fee for this pair, and none is estimated.' })
  feesNote!: string;

  @ApiProperty({
    description: 'Machine-readable notes about what was missing or excluded while building this quote.',
    type: [String],
  })
  reasons!: string[];
}

/** Maps the service result onto the response metadata block. */
export function toPricingMetadata(result: UsdtPricingResult): UsdtPricingMetadataDto {
  return {
    status: result.status,
    execution: result.executionMeta
      ? {
          source: result.executionMeta.source,
          bookTimestamp: result.executionMeta.bookTimestamp,
          fetchedAt: result.executionMeta.fetchedAt,
          tickerLast: result.executionMeta.tickerLast,
          bookVwap: formatDecimal(result.executionMeta.bookVwap, INR_DECIMALS),
        }
      : null,
    guarantee: result.guarantee ? toGuaranteeDto(result.guarantee, result.quote.side) : null,
    referenceBasis: result.referenceBasis,
    competitors: result.competitors.map((venue) => ({ ...venue })),
    aggregate: result.aggregate ? { ...result.aggregate } : null,
    fallback: result.fallback ? { ...result.fallback } : null,
    feesNote: 'fees not included',
    reasons: [...result.reasons],
  };
}

function toGuaranteeDto(guarantee: BestPriceGuarantee, side: UsdtOrderSide): UsdtGuaranteeDto {
  const margin = MIN_MARKET_ADVANTAGE_INR.toFixed(INR_DECIMALS);
  const direction = side === 'BUY' ? `capped to at least ${margin} below` : `floored to at least ${margin} above`;
  return {
    applied: guarantee.applied,
    matchedVenue: guarantee.matchedVenue,
    matchedPrice: guarantee.matchedPrice === null ? null : guarantee.matchedPrice.toString(),
    note: guarantee.applied
      ? `Order-book VWAP ${direction} the best venue offer (${guarantee.matchedVenue} ${guarantee.matchedPrice?.toString() ?? ''}) and settled at ${guarantee.price.toString()}.`
      : `The order book already beat the best venue by more than ${margin}; nothing was changed.`,
  };
}
