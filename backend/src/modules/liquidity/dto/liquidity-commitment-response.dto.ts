import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { LiquidityCommitment, LiquidityProvider } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { USDT_DECIMALS } from '../../usdt/domain/usdt-pricing';

/** EMBER display scale - matches the `EMBER` asset row in `asset-seed.ts` (18). */
export const EMBER_DECIMALS = 18;

/**
 * MODULE 09 — one LP commitment as the API reports it.
 *
 * `usdtAvailable = usdtCommitted - usdtConsumed` is the invariant the service
 * maintains; `emberLocked` is the EMBER currently held for this commitment,
 * sized by the configured slabs (reported even when none are approved - the
 * value is then always zero).
 */
export class LiquidityCommitmentDto {
  @ApiProperty({ description: 'Commitment id.', format: 'uuid' })
  commitmentId!: string;

  @ApiProperty({ description: 'The LP that owns this commitment.', format: 'uuid' })
  lpId!: string;

  @ApiProperty({ description: 'Lifecycle state.', enum: ['ACTIVE', 'CLOSED'] })
  status!: string;

  @ApiProperty({ description: 'Total pledged USDT.', example: '250000.000000' })
  usdtCommitted!: string;

  @ApiProperty({ description: 'USDT already delivered to customer BUY orders.', example: '0.000000' })
  usdtConsumed!: string;

  @ApiProperty({ description: 'Allocatable USDT remaining.', example: '250000.000000' })
  usdtAvailable!: string;

  @ApiProperty({ description: 'EMBER currently locked in the LP wallet for this commitment.', example: '45000.000000000000000000' })
  emberLocked!: string;

  @ApiProperty({ description: 'Client request key of the most recent create/increase.', format: 'uuid' })
  clientRequestId!: string;

  @ApiProperty({ description: 'When the commitment opened, ISO-8601.' })
  committedAt!: string;

  @ApiPropertyOptional({ description: 'When the commitment was fully withdrawn and closed, ISO-8601.' })
  closedAt!: string | null;

  static from(commitment: LiquidityCommitment): LiquidityCommitmentDto {
    return {
      commitmentId: commitment.commitmentId,
      lpId: commitment.lpId,
      status: commitment.status,
      usdtCommitted: formatDecimal(commitment.usdtCommitted, USDT_DECIMALS),
      usdtConsumed: formatDecimal(commitment.usdtConsumed, USDT_DECIMALS),
      usdtAvailable: formatDecimal(commitment.usdtAvailable, USDT_DECIMALS),
      emberLocked: formatDecimal(commitment.emberLocked, EMBER_DECIMALS),
      clientRequestId: commitment.clientRequestId,
      committedAt: commitment.committedAt.toISOString(),
      closedAt: commitment.closedAt?.toISOString() ?? null,
    };
  }
}

/** The caller's LP registration, when one exists. */
export class LiquidityProviderDto {
  @ApiProperty({ description: 'LP id.', format: 'uuid' })
  lpId!: string;

  @ApiProperty({ description: 'Provider status.', enum: ['ACTIVE', 'SUSPENDED'] })
  status!: string;

  @ApiProperty({ description: 'When the user registered as an LP, ISO-8601.' })
  registeredAt!: string;

  static from(provider: LiquidityProvider): LiquidityProviderDto {
    return {
      lpId: provider.lpId,
      status: provider.status,
      registeredAt: provider.registeredAt.toISOString(),
    };
  }
}
