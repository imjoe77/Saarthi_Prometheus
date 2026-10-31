import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { StrategyFill } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import { toIsoDay } from '../../market-data/domain/day-window';

/**
 * MODULE 06b - one simulated fill.
 *
 * EVERY FIELD IS A FACT ABOUT A PAPER ORDER, and the shape says so by carrying
 * the evidence rather than a disclaimer: `sequenceNo` proves the order the
 * engine produced, `fillDay` is always the day *after* the signal that caused
 * it, and `cashAfter` lets a reader replay the ledger and check that the fills
 * add up to the balance the next row reports.
 *
 * `note` is the rule's own words (`sma_cross_up`, `donchian_breakout_down`) and
 * not a free-text explanation, because the engine knows which branch fired and
 * nothing else. It is nullable in the schema for a rule that has no reason to
 * give; every shipped rule gives one.
 */
export class FillResponseDto {
  @ApiProperty({ description: '1-based position in the simulation.', example: 4 })
  sequenceNo!: number;

  @ApiProperty({ description: 'UTC day the fill executed on - the day after the signal.', example: '2025-05-30' })
  fillDay!: string;

  @ApiProperty({ description: 'Direction of the simulated order.', enum: ['BUY', 'SELL'] })
  side!: string;

  @ApiProperty({ description: 'Symbol the fill executed on.', example: 'SOLUSDT' })
  symbol!: string;

  @ApiProperty({ description: 'Base-asset quantity, truncated to 8 decimal places.', example: '647.14232048' })
  quantity!: string;

  @ApiProperty({ description: "That day's open - the only price a fill can execute at.", example: '166.71' })
  price!: string;

  @ApiProperty({ description: 'quantity x price, before the fee.', example: '107885.0962472208' })
  gross!: string;

  @ApiProperty({ description: 'gross x the assumed fee rate.', example: '107.8850962472208' })
  fee!: string;

  @ApiProperty({ description: 'Paper cash immediately after this fill.', example: '107777.2111510173304' })
  cashAfter!: string;

  @ApiPropertyOptional({
    description: "The rule's own reason for firing.",
    nullable: true,
    example: 'donchian_breakout_down',
  })
  note!: string | null;

  static from(this: void, fill: StrategyFill): FillResponseDto {
    return {
      sequenceNo: fill.sequenceNo,
      fillDay: toIsoDay(fill.fillDay),
      side: fill.side,
      symbol: fill.symbol,
      quantity: decimalString(fill.quantity),
      price: decimalString(fill.price),
      gross: decimalString(fill.gross),
      fee: decimalString(fill.fee),
      cashAfter: decimalString(fill.cashAfter),
      note: fill.note,
    };
  }
}
