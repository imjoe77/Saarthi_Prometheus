import { ApiProperty } from '@nestjs/swagger';
import type { StrategyDailyBalance } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import { toIsoDay } from '../../market-data/domain/day-window';

/**
 * MODULE 06b - one day of paper holdings and total value.
 *
 * THE DECOMPOSITION IS THE POINT. `value` is the number Module 06 measures, and
 * the three columns beside it are what make it checkable: `cash` plus
 * `positionValue` equals `value`, and `positionValue` is `positionQty` times
 * that day's close. A single `value` column would be a figure a reader has to
 * take on trust; four columns that reconcile are a figure a reader can verify
 * with arithmetic in their head.
 *
 * ONE ROW PER DAY, INCLUDING DAYS NOTHING HAPPENED. A flat day with no fill is
 * still a day the strategy had a value, and the Risk Engine's series contract
 * refuses gaps - so "no trade today" is recorded as a row, not as an absence.
 * An absence would describe a different history from the one claimed.
 */
export class BalanceResponseDto {
  @ApiProperty({ description: 'UTC day this balance covers.', example: '2025-01-02' })
  day!: string;

  @ApiProperty({ description: 'Paper cash held overnight into this day.', example: '0.0004180393218' })
  cash!: string;

  @ApiProperty({ description: 'Base-asset units held. Zero when flat.', example: '1.05611819' })
  positionQty!: string;

  @ApiProperty({ description: "positionQty x that day's close. Zero when flat.", example: '102427.4008723301' })
  positionValue!: string;

  @ApiProperty({ description: 'cash + positionValue - the equity Module 06 measures.', example: '102427.4012903694218' })
  value!: string;

  static from(this: void, balance: StrategyDailyBalance): BalanceResponseDto {
    return {
      day: toIsoDay(balance.day),
      cash: decimalString(balance.cash),
      positionQty: decimalString(balance.positionQty),
      positionValue: decimalString(balance.positionValue),
      value: decimalString(balance.value),
    };
  }
}
