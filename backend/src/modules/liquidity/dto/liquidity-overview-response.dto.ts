import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { LiquidityTopUpRequest, Prisma } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { USDT_DECIMALS } from '../../usdt/domain/usdt-pricing';

/** Open or resolved shortfall notices, oldest detection first when listed. */
export class LiquidityTopUpRequestDto {
  @ApiProperty({ description: 'Top-up request id.', format: 'uuid' })
  topUpRequestId!: string;

  @ApiProperty({ description: 'Shortfall observed when the request opened, USDT.', example: '150000.000000' })
  requiredUsdt!: string;

  @ApiProperty({ description: 'Threshold in force at detection, USDT.', example: '200000.000000' })
  thresholdUsdt!: string;

  @ApiProperty({ description: 'Notice lifecycle.', enum: ['OPEN', 'FULFILLED', 'CANCELLED'] })
  status!: string;

  @ApiProperty({ description: 'When the shortfall was detected, ISO-8601.' })
  openedAt!: string;

  @ApiPropertyOptional({ description: 'When the notice resolved, ISO-8601.' })
  resolvedAt!: string | null;

  static from(request: {
    topUpRequestId: string;
    requiredUsdt: Prisma.Decimal;
    thresholdUsdt: Prisma.Decimal;
    status: string;
    openedAt: Date;
    resolvedAt: Date | null;
  }): LiquidityTopUpRequestDto {
    return {
      topUpRequestId: request.topUpRequestId,
      requiredUsdt: formatDecimal(request.requiredUsdt, USDT_DECIMALS),
      thresholdUsdt: formatDecimal(request.thresholdUsdt, USDT_DECIMALS),
      status: request.status,
      openedAt: request.openedAt.toISOString(),
      resolvedAt: request.resolvedAt?.toISOString() ?? null,
    };
  }
}

/**
 * MODULE 09 — aggregate liquidity health against the configured threshold.
 *
 * Read-only for the numbers: `aggregateAvailableUsdt` sums what ACTIVE
 * commitments of ACTIVE providers can still allocate. Detection persists at
 * most one OPEN request - a notice, never a transaction: fulfilling it is a
 * normal commitment increase by whichever LP chooses to act.
 *
 * `commitmentsEnabled` reports whether approved EMBER slabs are configured,
 * so a client can tell "disabled by configuration" from "below threshold".
 */
export class LiquidityOverviewDto {
  @ApiProperty({ description: 'Aggregate allocatable USDT across eligible commitments.', example: '150000.000000' })
  aggregateAvailableUsdt!: string;

  @ApiProperty({ description: 'Configured shortfall threshold, USDT.', example: '200000.000000' })
  thresholdUsdt!: string;

  @ApiProperty({ description: 'How far below the threshold the system is, USDT.', example: '50000.000000' })
  shortfallUsdt!: string;

  @ApiProperty({ description: 'True while aggregate liquidity sits below the threshold.' })
  belowThreshold!: boolean;

  @ApiProperty({ description: 'Whether commitment mutations are enabled (approved slabs configured).' })
  commitmentsEnabled!: boolean;

  @ApiPropertyOptional({ description: 'The currently OPEN shortfall notice, when one exists.' })
  openRequest!: LiquidityTopUpRequestDto | null;

  static from(input: {
    aggregate: Prisma.Decimal;
    threshold: Prisma.Decimal;
    shortfall: Prisma.Decimal;
    belowThreshold: boolean;
    commitmentsEnabled: boolean;
    openRequest: LiquidityTopUpRequest | null;
  }): LiquidityOverviewDto {
    return {
      aggregateAvailableUsdt: formatDecimal(input.aggregate, USDT_DECIMALS),
      thresholdUsdt: formatDecimal(input.threshold, USDT_DECIMALS),
      shortfallUsdt: formatDecimal(input.shortfall, USDT_DECIMALS),
      belowThreshold: input.belowThreshold,
      commitmentsEnabled: input.commitmentsEnabled,
      openRequest: input.openRequest ? LiquidityTopUpRequestDto.from(input.openRequest) : null,
    };
  }
}
