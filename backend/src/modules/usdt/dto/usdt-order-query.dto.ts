import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * MODULE 08 — query parameters for the order history.
 *
 * `cursor` is an opaque keyset token, not an offset, for the same reason the
 * wallet's transaction history uses one: an offset can skip or repeat rows when
 * new orders arrive between requests, while a keyset cursor pins the page to
 * `(placedAt, orderId)` and stays stable.
 */
export class UsdtOrderQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor returned as `nextCursor` by the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ description: 'Page size.', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
