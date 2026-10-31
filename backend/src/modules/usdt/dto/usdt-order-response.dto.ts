import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma, type UsdtOrder } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import type { BuyAllocationOutcome } from '../../liquidity/liquidity-allocation.service';
import { INR_DECIMALS, USDT_DECIMALS } from '../domain/usdt-pricing';
import type { UsdtPricingMetadataDto } from './usdt-pricing-metadata.dto';

/** One LP commitment's slice of a BUY order, at the order's execution price. */
export class UsdtLiquiditySliceDto {
  @ApiProperty({ description: 'Commitment that funded the slice.', format: 'uuid' })
  commitmentId!: string;

  @ApiProperty({ description: 'Liquidity provider that funded the slice.', format: 'uuid' })
  lpId!: string;

  @ApiProperty({ description: 'USDT this LP delivered.', example: '10000.000000' })
  usdtAmount!: string;

  @ApiProperty({ description: 'INR this LP received for the slice.', example: '1001500.00' })
  inrAmount!: string;

  @ApiProperty({ description: 'Execution price the slice settled at, INR per USDT.', example: '100.15' })
  priceInr!: string;
}

/**
 * MODULE 09 - which simulated LPs funded a BUY order.
 *
 * The slices sum exactly to the order's own figures: USDT slices equal
 * `usdtAmount`, INR credits equal `inrAmount` (the final slice carries the
 * paisa rounding remainder), and every slice settles at the order's
 * prometheusPrice - customer and LP legs agree to the paisa. Present on BUY
 * creation responses only when at least one provider exists; a legacy order
 * (no providers) and every SELL carry no block.
 */
export class UsdtLiquidityBlockDto {
  @ApiProperty({ type: [UsdtLiquiditySliceDto], description: 'Funding slices, oldest commitment first.' })
  slices!: UsdtLiquiditySliceDto[];

  @ApiProperty({ description: 'USDT funded by LPs; equals the order volume.', example: '10000.000000' })
  totalUsdt!: string;

  @ApiProperty({ description: 'INR paid to LPs; equals the customer debit.', example: '1001500.00' })
  totalInr!: string;
}

/** Builds the response block, or undefined when nothing was LP-funded. */
export function toLiquidityBlock(outcome: BuyAllocationOutcome | undefined): UsdtLiquidityBlockDto | undefined {
  if (!outcome || outcome.legacy || outcome.slices.length === 0) {
    return undefined;
  }

  const totalUsdt = outcome.slices.reduce((sum, slice) => sum.add(slice.usdtAmount), new Prisma.Decimal(0));
  const totalInr = outcome.slices.reduce((sum, slice) => sum.add(slice.inrAmount), new Prisma.Decimal(0));

  return {
    slices: outcome.slices.map((slice) => ({
      commitmentId: slice.commitmentId,
      lpId: slice.lpId,
      usdtAmount: formatDecimal(slice.usdtAmount, USDT_DECIMALS),
      inrAmount: formatDecimal(slice.inrAmount, INR_DECIMALS),
      priceInr: formatDecimal(slice.priceInr, INR_DECIMALS),
    })),
    totalUsdt: formatDecimal(totalUsdt, USDT_DECIMALS),
    totalInr: formatDecimal(totalInr, INR_DECIMALS),
  };
}

/**
 * MODULE 08 — one recorded USDT exchange order.
 *
 * A row exists only if the balance legs committed with it, so every response
 * here describes a settled order: the snapshot prices explain what was charged,
 * `savings` is the reference-price metric recorded with it, and `filledAt`
 * equals `placedAt` because execution is synchronous.
 *
 * Order rows are only ever written from live market data - the fallback and
 * stale prices are refused at execution time - so nothing in this response
 * can be a fallback figure. The optional `pricing` block (order creation
 * responses only) carries the provenance of that live data: execution source
 * and timestamps, competitor venues, and the reference basis.
 */
export class UsdtOrderResponseDto {
  @ApiProperty({ description: 'Server order id.', format: 'uuid', example: '1f4c4034-2cd1-40c3-b7dd-a88578418f66' })
  orderId!: string;

  @ApiProperty({ description: 'Direction of the order.', enum: ['BUY', 'SELL'] })
  side!: string;

  @ApiProperty({ description: 'USDT volume.', example: '10000.000000' })
  usdtAmount!: string;

  @ApiProperty({ description: 'INR paid (BUY) or received (SELL).', example: '1001500.00' })
  inrAmount!: string;

  @ApiProperty({ description: 'Zero-brokerage execution price this order settled at, INR per USDT.', example: '100.15' })
  prometheusPrice!: string;

  @ApiProperty({ description: 'Reference price the savings was measured against, INR per USDT.', example: '100.20' })
  referencePrice!: string;

  @ApiProperty({ description: 'Signed reference-price savings recorded with the order.', example: '50.00' })
  savings!: string;

  @ApiProperty({ description: 'Client request id this order fulfilled.', format: 'uuid' })
  clientRequestId!: string;

  @ApiProperty({ description: 'When the request was accepted, ISO-8601.', example: '2026-10-13T10:00:00.000Z' })
  placedAt!: string;

  @ApiProperty({ description: 'When the settlement committed, ISO-8601.', example: '2026-10-13T10:00:00.000Z' })
  filledAt!: string;

  @ApiPropertyOptional({
    description:
      'Live pricing provenance, present on order-creation responses (201). Omitted on replays (200) and history pages, whose rows record the numeric snapshot.',
  })
  pricing!: UsdtPricingMetadataDto | undefined;

  @ApiPropertyOptional({
    description:
      'MODULE 09 LP funding slices, present on BUY creation responses once at least one liquidity provider exists. Omitted on SELL, replays, history pages, and legacy orders placed before any provider was registered.',
  })
  liquidity!: UsdtLiquidityBlockDto | undefined;

  static from(
    order: UsdtOrder,
    pricing?: UsdtPricingMetadataDto,
    liquidity?: UsdtLiquidityBlockDto,
  ): UsdtOrderResponseDto {
    return {
      orderId: order.orderId,
      side: order.side,
      usdtAmount: formatDecimal(order.usdtAmount, USDT_DECIMALS),
      inrAmount: formatDecimal(order.inrAmount, INR_DECIMALS),
      prometheusPrice: formatDecimal(order.prometheusPrice, INR_DECIMALS),
      referencePrice: formatDecimal(order.referencePrice, INR_DECIMALS),
      savings: formatDecimal(order.savings, INR_DECIMALS),
      clientRequestId: order.clientRequestId,
      placedAt: order.placedAt.toISOString(),
      filledAt: order.filledAt.toISOString(),
      pricing,
      liquidity,
    };
  }
}
