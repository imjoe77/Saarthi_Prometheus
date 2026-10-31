import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * MODULE 06b - query parameters for `GET /api/market/candles`.
 *
 * OFFSET PAGINATION AGAIN, FOR THE SAME REASON MODULE 05 USES IT. A candle
 * window is a fixed historical range: rows are never inserted in the middle of
 * it, so the boundary-shift problem that a cursor exists to solve does not
 * arise, and a chart requesting page 7 of a symbol it knows is 644 days long is
 * a simpler thing to reason about than a keyset it has to carry between calls.
 *
 * `symbol` is the only required parameter and the only one that can produce a
 * 404: an unknown symbol is a question about a thing that does not exist, not a
 * malformed request. Case is not significant - `btcusdt` and `BTCUSDT` name the
 * same market - so the service uppercases before it queries rather than making
 * callers learn the source's capitalisation.
 *
 * `from` and `to` are plain calendar days, inclusive at both ends. Requiring the
 * bare `YYYY-MM-DD` form rather than accepting any ISO-8601 instant is what keeps
 * the window a *day* boundary: `2025-01-01T18:00:00Z` would silently exclude the
 * first eighteen hours of a bar the API is about to describe as a day.
 *
 * No default is written into the DTO. `page` and `limit` are applied by the
 * service, the same way Module 05 does it, so "what are the defaults" has one
 * answer in the code that queries rather than two in a validator and a query
 * builder that could drift apart.
 */
export class MarketCandlesQueryDto {
  @ApiPropertyOptional({ description: 'Binance symbol. Case-insensitive.', example: 'BTCUSDT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'symbol must be alphanumeric, for example BTCUSDT',
  })
  symbol!: string;

  @ApiPropertyOptional({ description: 'First day to include, inclusive.', example: '2025-01-01' })
  @IsOptional()
  @IsDateString()
  @Matches(ISO_DAY, { message: 'from must be a calendar day in YYYY-MM-DD form' })
  from?: string;

  @ApiPropertyOptional({ description: 'Last day to include, inclusive.', example: '2025-03-31' })
  @IsOptional()
  @IsDateString()
  @Matches(ISO_DAY, { message: 'to must be a calendar day in YYYY-MM-DD form' })
  to?: string;

  @ApiPropertyOptional({ description: '1-based page number.', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Page size.', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
