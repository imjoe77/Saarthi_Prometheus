import { ApiProperty } from '@nestjs/swagger';

import { decimalString } from '../../market-data/domain/decimal-string';
import type { SimulationRecord } from '../persistence/simulation-store';

/**
 * MODULE 06b - one simulation, and the loudest thing in it.
 *
 * `simulated` AND `notRealTrades` ARE ALWAYS PRESENT AND ALWAYS TRUE. They are
 * not convenience flags for a client that might want to filter; they are the
 * answer to the only question that matters when a number looks like a return:
 * nothing here was bought, sold or held by anybody. The schema says it, the
 * table comments say it, and a response that reaches a screen says it too -
 * because the table comment is the one part of that chain a reader cannot see.
 *
 * THE ASSUMPTION IS PART OF THE ANSWER. `feeRate` is not a measurement: the
 * dataset has no fee column, and Binance fees depend on tier and membership.
 * Returning the rate alongside `assumption` means the number cannot be quoted
 * without the sentence that explains where it came from.
 *
 * MONEY IS STRINGS, as everywhere else. `initialCash` and `feeRate` are exact
 * decimal strings rather than JSON numbers, for the same reason a balance is -
 * `0.001` happens to survive a float round-trip, and the discipline must not
 * depend on which values do.
 */
export class SimulationResponseDto {
  @ApiProperty({ description: 'Strategy the simulation belongs to.', format: 'uuid' })
  strategyId!: string;

  @ApiProperty({ description: 'Catalogue key of the rule that produced it.', example: 'sma-cross-eth' })
  ruleKey!: string;

  @ApiProperty({ description: 'Version of that rule, stored with the curve.', example: 1 })
  ruleVersion!: number;

  @ApiProperty({ description: 'The single symbol the rule trades.', example: 'ETHUSDT' })
  symbol!: string;

  @ApiProperty({ description: 'First UTC day in the window.', example: '2025-01-01' })
  windowStart!: string;

  @ApiProperty({ description: 'Last UTC day in the window.', example: '2026-10-06' })
  windowEnd!: string;

  @ApiProperty({ description: 'Paper starting cash, in paper USDT.', example: '100000' })
  initialCash!: string;

  @ApiProperty({
    description: 'Assumed taker fee rate. Stated assumption - the dataset carries no fee data.',
    example: '0.001',
  })
  feeRate!: string;

  @ApiProperty({ description: 'Days in the curve, one balance row each.', example: 644 })
  dayCount!: number;

  @ApiProperty({ description: 'Simulated fills in the curve.', example: 9 })
  fillCount!: number;

  @ApiProperty({ description: 'When this simulation was computed, ISO-8601.' })
  computedAt!: string;

  @ApiProperty({
    description: 'Always true: this curve was computed, not traded.',
    example: true,
  })
  simulated!: boolean;

  @ApiProperty({
    description: 'Always true: no real orders were placed and no real money moved.',
    example: true,
  })
  notRealTrades!: boolean;

  @ApiProperty({
    description: 'The assumptions the numbers rest on.',
    example:
      'Paper USDT, long only, no leverage, fills at the next day open, 0.001 fee assumed, no slippage.',
  })
  assumption!: string;

  static from(record: SimulationRecord): SimulationResponseDto {
    return {
      strategyId: record.strategyId,
      ruleKey: record.ruleKey,
      ruleVersion: record.ruleVersion,
      symbol: record.symbol,
      windowStart: record.windowStart,
      windowEnd: record.windowEnd,
      initialCash: decimalString(record.initialCash),
      feeRate: decimalString(record.feeRate),
      dayCount: record.dayCount,
      fillCount: record.fillCount,
      computedAt: record.computedAt.toISOString(),
      simulated: true,
      notRealTrades: true,
      assumption:
        'Paper USDT, long only, no leverage, fills at the next day open, ' +
        'fee rate as reported above, no slippage.',
    };
  }
}
