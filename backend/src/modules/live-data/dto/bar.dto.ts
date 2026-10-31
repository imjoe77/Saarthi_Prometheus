import { ApiProperty } from '@nestjs/swagger';

import type { LiveBar } from '../providers/market-data-provider.port';

/**
 * MODULE 06c - one live bar.
 *
 * Every price is a decimal string straight from the provider, so a chart
 * library and a Decimal math layer both start from the digits that were
 * observed rather than from a binary double.
 */
export class BarDto {
  @ApiProperty({ description: 'Canonical symbol the bar belongs to.', example: 'BTC/USD' })
  symbol!: string;

  @ApiProperty({ description: 'Bar timeframe.', enum: ['1m', '5m', '15m', '1h', '1d'] })
  timeframe!: string;

  @ApiProperty({ description: 'Bar open instant, RFC 3339 UTC.', example: '2026-03-01T14:30:00.000Z' })
  time!: string;

  @ApiProperty({ description: 'Open price.', example: '97000.5' })
  open!: string;

  @ApiProperty({ description: 'High price.', example: '97210.25' })
  high!: string;

  @ApiProperty({ description: 'Low price.', example: '96880.0' })
  low!: string;

  @ApiProperty({ description: 'Close price.', example: '97130.75' })
  close!: string;

  @ApiProperty({ description: 'Base-asset volume.', example: '4850' })
  volume!: string;

  static from(bar: LiveBar): BarDto {
    return {
      symbol: bar.symbol,
      timeframe: bar.timeframe,
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    };
  }
}