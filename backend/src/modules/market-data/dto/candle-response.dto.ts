import { ApiProperty } from '@nestjs/swagger';
import type { MarketCandle } from '@prisma/client';

import { decimalString } from '../domain/decimal-string';
import { toIsoDay } from '../domain/day-window';

/**
 * MODULE 06b - one historical daily bar as the API returns it.
 *
 * MONEY IS A STRING. Every figure is `Decimal` in the database and a decimal
 * string here, because `94591.780000000000000000` parsed into a JavaScript
 * `number` is `94591.78000000001` and a chart that wobbles by a ten-billionth
 * is a chart nobody can trust. The same reasoning that keeps `number` out of the
 * ledger keeps it out of the read API that feeds a chart from the ledger.
 *
 * THE DAY IS A DATE, NOT A TIMESTAMP. The bar covers a whole UTC session; a
 * timestamp would imply an intraday precision the source does not have and a
 * time zone the source does not express.
 *
 * `sourceFile` and `importedAt` are not exposed. The filename behind a row is
 * provenance for whoever operates the import, not for a client drawing a line,
 * and the honest answer to "when did this candle happen" is `day` - which is
 * already here - rather than when a script happened to run.
 */
export class CandleResponseDto {
  @ApiProperty({ description: 'Binance symbol.', example: 'BTCUSDT' })
  symbol!: string;

  @ApiProperty({ description: 'UTC calendar day the bar covers.', example: '2025-01-01' })
  day!: string;

  @ApiProperty({ description: 'Opening price.', example: '94591.78' })
  open!: string;

  @ApiProperty({ description: 'Highest price.', example: '96576.01' })
  high!: string;

  @ApiProperty({ description: 'Lowest price.', example: '93576.00' })
  low!: string;

  @ApiProperty({ description: 'Closing price.', example: '94479.40' })
  close!: string;

  @ApiProperty({ description: 'Base-asset volume over the day.', example: '11671.20666' })
  volume!: string;

  @ApiProperty({ description: 'Quote-asset volume over the day.', example: '1094452917.66453' })
  quoteVolume!: string;

  static from(this: void, candle: MarketCandle): CandleResponseDto {
    return {
      symbol: candle.symbol,
      day: toIsoDay(candle.day),
      open: decimalString(candle.open),
      high: decimalString(candle.high),
      low: decimalString(candle.low),
      close: decimalString(candle.close),
      volume: decimalString(candle.volume),
      quoteVolume: decimalString(candle.quoteVolume),
    };
  }
}
