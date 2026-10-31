import { ApiProperty } from '@nestjs/swagger';
import type { LiquidityCommitmentReduction } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { USDT_DECIMALS } from '../../usdt/domain/usdt-pricing';
import { EMBER_DECIMALS } from './liquidity-commitment-response.dto';

/**
 * MODULE 09 — one completed (or replayed) commitment reduction.
 *
 * `emberUnlocked` is the EMBER surplus this reduction released - it can be
 * more than the USDT figure implies only when the slab requirement fell, and
 * it is always the difference between the old lock and the newly required one.
 */
export class LiquidityReductionDto {
  @ApiProperty({ description: 'Reduction id.', format: 'uuid' })
  reductionId!: string;

  @ApiProperty({ description: 'The commitment that shrank.', format: 'uuid' })
  commitmentId!: string;

  @ApiProperty({ description: 'USDT withdrawn.', example: '50000.000000' })
  usdtAmount!: string;

  @ApiProperty({ description: 'EMBER released back to the LP wallet.', example: '25000.000000000000000000' })
  emberUnlocked!: string;

  @ApiProperty({ description: 'Client request key this reduction fulfilled.', format: 'uuid' })
  clientRequestId!: string;

  @ApiProperty({ description: 'When the reduction committed, ISO-8601.' })
  reducedAt!: string;

  static from(reduction: LiquidityCommitmentReduction): LiquidityReductionDto {
    return {
      reductionId: reduction.reductionId,
      commitmentId: reduction.commitmentId,
      usdtAmount: formatDecimal(reduction.usdtAmount, USDT_DECIMALS),
      emberUnlocked: formatDecimal(reduction.emberUnlocked, EMBER_DECIMALS),
      clientRequestId: reduction.clientRequestId,
      reducedAt: reduction.reducedAt.toISOString(),
    };
  }
}
