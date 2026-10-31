import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * MODULE 07 - pagination for the copy listings.
 *
 * The same bounds, defaults and reasoning as Modules 05, 06 and 06b: a 1-based
 * offset, 20 rows by default, never more than 100. These lists are re-read and
 * re-sorted on every request - a follow's counts change as the engine runs - so
 * an offset repeats or skips at worst one row at a page boundary, and unlike a
 * keyset it survives a page number the user typed by hand.
 *
 * Defaults live here as documentation only; the service applies them, so there
 * is exactly one definition of "page 1 of everything".
 */
export class CopyPageQueryDto {
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
