import { ApiProperty } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import type { PerformancePoint } from '../domain/copy-performance';

/**
 * MODULE 07 - the profit-and-loss path of a follower's copy book.
 *
 * THE TOTAL IS THE LEDGER'S. `realizedPnl` is the sum of `copy_accounts`
 * .realized_pnl - the figure the engine wrote inside the same transaction
 * that moved the position. The path is a replay of the event table, so the
 * two must agree; the API reports the ledger's number and never the replay's.
 *
 * EVERY MONEY FIGURE IS A STRING. Decimal money in a JSON number is a number
 * that has already lost precision by the time a client reads it, so the
 * convention this project follows everywhere else applies here too.
 *
 * NO UNREALISED MARK. The aggregate account route refuses to price a
 * position, because pricing one needs a quote this module deliberately does
 * not fetch. Marking an open position is the same decision: a screen that
 * wants a live mark fetches the live quote itself and says which quote it
 * used, rather than this route inventing a price it cannot defend.
 */
export class CopyPerformancePointDto {
  @ApiProperty({ description: 'The strategy whose fill produced this point.' })
  strategyId!: string;

  @ApiProperty()
  symbol!: string;

  @ApiProperty({ description: 'Direction of the copied fill.', enum: ['LONG', 'SHORT'] })
  side!: 'LONG' | 'SHORT';

  @ApiProperty({ description: 'Quantity the follower executed.' })
  quantity!: string;

  @ApiProperty({ description: 'Price the follower executed at.' })
  fillPrice!: string;

  @ApiProperty({ description: 'quantity x fillPrice.' })
  gross!: string;

  @ApiProperty({
    description:
      'Profit or loss this single fill realised. Zero for a fill that only opened or added to a position - it moves ' +
      'cash into the book and realises nothing yet.',
  })
  realizedPnl!: string;

  @ApiProperty({ description: 'Running realised profit and loss across every fill, up to and including this one.' })
  cumulativePnl!: string;

  @ApiProperty({ description: 'When the engine consumed this event.' })
  processedAt!: string;
}

export class CopyPerformanceResponseDto {
  @ApiProperty({ description: 'How many strategies the caller follows.' })
  followCount!: number;

  @ApiProperty({ description: 'Realised profit and loss, summed over the caller\'s separate pots.' })
  realizedPnl!: string;

  @ApiProperty({ description: 'Copy cash, summed over the caller\'s separate pots.' })
  cash!: string;

  @ApiProperty({ description: 'Fills the engine copied.' })
  copiedCount!: number;

  @ApiProperty({ description: 'Fills the engine refused, with their reasons in the history.' })
  rejectedCount!: number;

  @ApiProperty({ type: [CopyPerformancePointDto] })
  points!: CopyPerformancePointDto[];
}

/**
 * Builds the performance response from the replayed points and the ledger's
 * own total. Kept next to the DTO so the two shapes cannot drift apart.
 */
export function toPerformanceResponse(input: {
  followCount: number;
  realizedPnl: Prisma.Decimal;
  cash: Prisma.Decimal;
  copiedCount: number;
  rejectedCount: number;
  points: PerformancePoint[];
}): CopyPerformanceResponseDto {
  return {
    followCount: input.followCount,
    realizedPnl: decimalString(input.realizedPnl),
    cash: decimalString(input.cash),
    copiedCount: input.copiedCount,
    rejectedCount: input.rejectedCount,
    points: input.points.map((point) => ({
      strategyId: point.strategyId,
      symbol: point.symbol,
      side: point.side,
      quantity: decimalString(point.quantity),
      fillPrice: decimalString(point.fillPrice),
      gross: decimalString(point.gross),
      realizedPnl: decimalString(point.realizedPnl),
      cumulativePnl: decimalString(point.cumulativePnl),
      processedAt: point.processedAt.toISOString(),
    })),
  };
}
