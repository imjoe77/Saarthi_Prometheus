import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

import type { BarTimeframe } from '../providers/market-data-provider.port';

/**
 * MODULE 06c - query parameters for `GET /api/market-data/bars`.
 *
 * `symbol` is a query parameter for the same reason the quote route uses one:
 * the universe contains `BTC/USD`, and a slash inside a path segment is a
 * proxy-encoding footgun that a query parameter does not have. Two knobs
 * beside it - a timeframe and a page size - both capped so a careless client
 * cannot ask a free provider for a thousand bars at once.
 */
export class BarsQueryDto {
  @ApiProperty({ description: 'Canonical symbol, exactly as the catalogue spells it.', example: 'BTC/USD' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiPropertyOptional({ description: 'Bar timeframe.', enum: ['1m', '5m', '15m', '1h', '1d'], default: '1m' })
  @IsOptional()
  @IsEnum(['1m', '5m', '15m', '1h', '1d'] as const, {
    message: 'timeframe must be one of 1m, 5m, 15m, 1h, 1d',
  })
  timeframe?: BarTimeframe;

  @ApiPropertyOptional({ description: 'Number of bars, most recent first.', minimum: 1, maximum: 200, default: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}