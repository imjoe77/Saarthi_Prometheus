import { ApiProperty } from '@nestjs/swagger';
import type { LiquidityAllocation } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { INR_DECIMALS, USDT_DECIMALS } from '../../usdt/domain/usdt-pricing';

/**
 * MODULE 09 — one slice of a BUY order funded by one LP commitment.
 *
 * `priceInr` is the order's execution price (the CoinDCX VWAP the customer
 * settled at), so the customer leg and every LP leg agree to the paisa; the
 * per-slice INR the LP received is `usdtAmount x priceInr` with the final
 * slice carrying the rounding remainder of the customer's debit.
 */
export class LiquidityAllocationDto {
  @ApiProperty({ description: 'Allocation id.', format: 'uuid' })
  allocationId!: string;

  @ApiProperty({ description: 'Commitment that funded the slice.', format: 'uuid' })
  commitmentId!: string;

  @ApiProperty({ description: 'USDT this LP delivered.', example: '10000.000000' })
  usdtAmount!: string;

  @ApiProperty({ description: 'Execution price the slice settled at, INR per USDT.', example: '100.15' })
  priceInr!: string;

  @ApiProperty({ description: 'When the slice committed, ISO-8601.' })
  allocatedAt!: string;

  static from(allocation: LiquidityAllocation): LiquidityAllocationDto {
    return {
      allocationId: allocation.allocationId,
      commitmentId: allocation.commitmentId,
      usdtAmount: formatDecimal(allocation.usdtAmount, USDT_DECIMALS),
      priceInr: formatDecimal(allocation.priceInr, INR_DECIMALS),
      allocatedAt: allocation.allocatedAt.toISOString(),
    };
  }
}
