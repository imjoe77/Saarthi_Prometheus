import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * MODULE 03 — query parameters for the transaction history.
 *
 * `cursor` is an opaque keyset token, not an offset. Offsets recompute the whole
 * preceding set on every page and can skip or repeat rows when new transactions
 * arrive between requests; a keyset cursor pins the page to `(createdAt, id)` and
 * stays stable. `limit` is clamped server-side as well, since this object is also
 * constructed directly in tests and by future callers.
 */
export class ListTransactionsQueryDto {
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
