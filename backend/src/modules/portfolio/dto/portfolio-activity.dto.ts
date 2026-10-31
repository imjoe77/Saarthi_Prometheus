import { ApiProperty } from '@nestjs/swagger';

import type { PortfolioActivity } from '../portfolio.types';

/**
 * MODULE 04 — movement counts per ledger type.
 *
 * Every member of `TransactionType` is present, including the ones with a count
 * of zero, so a client can render a complete picture without inventing defaults
 * and without the response shape changing as activity accumulates. Later modules
 * record `TRANSFER_IN`/`TRANSFER_OUT`/`ADJUSTMENT` and, since Module 11, `BURN`
 * through the same ledger primitives, so they need no change here.
 */
export class PortfolioActivityByTypeDto {
  @ApiProperty({ description: 'Value entering the wallet.', example: 3 })
  DEPOSIT!: number;

  @ApiProperty({ description: 'Value leaving the wallet.', example: 1 })
  WITHDRAWAL!: number;

  @ApiProperty({ description: 'Inbound leg of a transfer.', example: 0 })
  TRANSFER_IN!: number;

  @ApiProperty({ description: 'Outbound leg of a transfer.', example: 0 })
  TRANSFER_OUT!: number;

  @ApiProperty({ description: 'Moves available into locked.', example: 2 })
  LOCK!: number;

  @ApiProperty({ description: 'Moves locked back into available.', example: 1 })
  UNLOCK!: number;

  @ApiProperty({ description: 'Manual correction.', example: 0 })
  ADJUSTMENT!: number;

  @ApiProperty({ description: 'Treasury destruction leg written by a burn.', example: 0 })
  BURN!: number;
}

/**
 * How much has moved, and when.
 *
 * Counts and timestamps only. Nothing here is a monetary total, because summing
 * balances across assets is not a meaningful quantity and summing *movements*
 * would be no more meaningful.
 */
export class PortfolioActivityDto {
  @ApiProperty({ description: 'Movements recorded against this wallet, all time.', example: 7 })
  totalMovements!: number;

  @ApiProperty({ description: 'Movements recorded in the last 30 days.', example: 7 })
  movementsLast30Days!: number;

  @ApiProperty({ description: 'Counts per ledger type.' })
  byType!: PortfolioActivityByTypeDto;

  @ApiProperty({
    description: 'When the first movement was recorded.',
    example: '2026-10-01T09:12:44.120Z',
  })
  firstMovementAt!: string;

  @ApiProperty({
    description: 'When the most recent movement was recorded.',
    example: '2026-10-02T11:45:47.900Z',
  })
  lastMovementAt!: string;

  static from(activity: PortfolioActivity): PortfolioActivityDto {
    return {
      totalMovements: activity.totalMovements,
      movementsLast30Days: activity.movementsLast30Days,
      byType: { ...activity.byType },
      firstMovementAt: activity.firstMovementAt,
      lastMovementAt: activity.lastMovementAt,
    };
  }
}