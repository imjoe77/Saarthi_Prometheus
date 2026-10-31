import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EmberStakePosition } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';

export class EmberStakePositionResponseDto {
  @ApiProperty({ description: 'Surrogate key of the position.', example: '2d3f3a6a-1b2c-4d6e-8f7a-1b2c3d4e5f6a' })
  stakeId!: string;

  @ApiProperty({ description: 'The EMBER locked into this position at ledger precision.', example: '1000.000000000000000000' })
  amount!: string;

  @ApiProperty({ description: 'ACTIVE while locked in, UNSTAKED after the unlock.', enum: ['ACTIVE', 'UNSTAKED'], example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ description: 'When the lock expires; unstaking before this is refused.', example: '2026-11-20T10:00:00.000Z' })
  lockUntil!: string;

  @ApiProperty({ description: 'The configured APR the simulation uses.', example: '8.4' })
  aprPercent!: string;

  @ApiProperty({ description: 'Whole days elapsed (or elapsed as of unstake, for finished positions).', example: 12 })
  elapsedDays!: number;

  @ApiProperty({ description: 'SIMULATED reward accrued over the elapsed days. Display-only: never credited, never minted, never changes supply.', example: '2.761643835616438356' })
  simulatedReward!: string;

  @ApiProperty({ description: 'The idempotency key of the stake request.', example: '1d7e9f2a-4b5c-4d6e-8f7a-1b2c3d4e5f6a' })
  clientRequestId!: string;

  @ApiProperty({ description: 'When the stake was created.', example: '2026-10-21T10:00:00.000Z' })
  stakedAt!: string;

  @ApiPropertyOptional({ description: 'When the position was unstaked, when it has been.' })
  unstakedAt!: string | null;

  static from(
    row: EmberStakePosition,
    simulation: { aprPercent: string; elapsedDays: number; simulatedReward: string },
  ): EmberStakePositionResponseDto {
    const dto = new EmberStakePositionResponseDto();
    dto.stakeId = row.stakeId;
    dto.amount = formatDecimal(row.amount, 18);
    dto.status = row.status;
    dto.lockUntil = row.lockUntil.toISOString();
    dto.aprPercent = simulation.aprPercent;
    dto.elapsedDays = simulation.elapsedDays;
    dto.simulatedReward = simulation.simulatedReward;
    dto.clientRequestId = row.clientRequestId;
    dto.stakedAt = row.stakedAt.toISOString();
    dto.unstakedAt = row.unstakedAt?.toISOString() ?? null;
    return dto;
  }
}

/** The configured lock period and APR a stake is actually opened with. */
export class EmberStakingConfigResponseDto {
  @ApiProperty({ description: 'Configured APR the simulated reward uses, in percent.', example: '8.4' })
  aprPercent!: string;

  @ApiProperty({ description: 'Configured lock duration in days; unstaking before it expires is refused.', example: 180 })
  lockDays!: number;
}

export class CreateStakeResponseDto {
  @ApiProperty({ type: EmberStakePositionResponseDto })
  position!: EmberStakePositionResponseDto;

  @ApiProperty({ description: 'True when this call created the position; false on an idempotent replay.', example: true })
  created!: boolean;

  static from(view: {
    position: EmberStakePosition;
    created: boolean;
    simulation: { aprPercent: string; elapsedDays: number; simulatedReward: string };
  }): CreateStakeResponseDto {
    const dto = new CreateStakeResponseDto();
    dto.position = EmberStakePositionResponseDto.from(view.position, view.simulation);
    dto.created = view.created;
    return dto;
  }
}

export class EmberStakePositionsResponseDto {
  @ApiProperty({ type: [EmberStakePositionResponseDto] })
  items!: EmberStakePositionResponseDto[];

  static from(rows: (EmberStakePosition & { simulation: { aprPercent: string; elapsedDays: number; simulatedReward: string } })[]): EmberStakePositionsResponseDto {
    const dto = new EmberStakePositionsResponseDto();
    dto.items = rows.map((row) => EmberStakePositionResponseDto.from(row, row.simulation));
    return dto;
  }
}
