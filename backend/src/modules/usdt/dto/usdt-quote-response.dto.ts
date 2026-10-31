import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { formatDecimal } from '../../wallet/decimal.util';
import { INR_DECIMALS, USDT_DECIMALS } from '../domain/usdt-pricing';
import type { UsdtPricingResult } from '../usdt-pricing.service';
import { toPricingMetadata, type UsdtPricingMetadataDto } from './usdt-pricing-metadata.dto';

/**
 * MODULE 08 extension — one quote with its full pricing provenance.
 *
 * `status` is the honesty switch: `live` means every figure came from fresh
 * market data (the execution book within `USDT_PRICE_MAX_AGE_MS`, references
 * within the reference window), and `fallback` means the prices are the
 * configured indicative fallback - never live, never a basis for a verified
 * savings claim, which is why `savings` is null there. `savings` is also null
 * on a live quote whose reference data was unavailable: no comparable data
 * means no claimed saving, not a guessed one. The figure is signed - always
 * positive when the customer is better off than the reference for the same
 * direction and quantity - and is a reference-price metric, never cash.
 */
export class UsdtQuoteResponseDto {
  @ApiProperty({ description: 'Direction of the quote.', enum: ['BUY', 'SELL'] })
  side!: string;

  @ApiProperty({ description: 'USDT volume quoted.', example: '10000.000000' })
  usdtAmount!: string;

  @ApiProperty({
    description: 'INR paid (BUY) or received (SELL) at the execution price; indicative when status is fallback.',
    example: '1001500.00',
  })
  inrAmount!: string;

  @ApiProperty({
    description:
      'Zero-brokerage execution price (order-book VWAP for this quantity, then capped/floored by the best-price guarantee so it is never worse for the customer than any comparable venue); the configured fallback when status is fallback.',
    example: '100.15',
  })
  prometheusPrice!: string;

  @ApiPropertyOptional({
    description: 'Fresh reference price the savings is measured against; null when no fresh reference existed.',
    example: '100.20',
  })
  referencePrice!: string | null;

  @ApiPropertyOptional({
    description:
      'Signed customer savings against the reference price for the same direction and quantity. Null on fallback or when no fresh reference existed - never fabricated.',
    example: '50.00',
  })
  savings!: string | null;

  @ApiProperty({ description: 'Source, status, competitors, aggregate and fallback metadata for this quote.' })
  pricing!: UsdtPricingMetadataDto;

  static from(result: UsdtPricingResult): UsdtQuoteResponseDto {
    return {
      side: result.quote.side,
      usdtAmount: formatDecimal(result.quote.usdtAmount, USDT_DECIMALS),
      inrAmount: formatDecimal(result.quote.inrAmount, INR_DECIMALS),
      prometheusPrice: formatDecimal(result.quote.prometheusPrice, INR_DECIMALS),
      referencePrice:
        result.quote.referencePrice === null
          ? null
          : formatDecimal(result.quote.referencePrice, INR_DECIMALS),
      savings: result.quote.savings === null ? null : formatDecimal(result.quote.savings, INR_DECIMALS),
      pricing: toPricingMetadata(result),
    };
  }
}
