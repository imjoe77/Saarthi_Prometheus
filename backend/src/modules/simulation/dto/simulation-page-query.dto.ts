import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/**
 * MODULE 06b - pagination for the two simulation sub-lists.
 *
 * One DTO for both `fills` and `balance` because they are one decision: the
 * same 1-based offset, the same bounds, the same defaults, and the same
 * reasoning Module 05 already recorded for choosing an offset over a cursor. A
 * simulated fill list is chronological and append-only *within a run*, and a run
 * is replaced wholesale when a rule is re-run - a cursor carried across a
 * re-run would point at a row that no longer exists, which is a worse failure
 * than a page number that repeats or skips one.
 *
 * Defaults live here only as documentation; the service applies them, so there
 * is exactly one place that decides what "page 1 of everything" means.
 */
export class SimulationPageQueryDto {
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

export { DEFAULT_PAGE, DEFAULT_LIMIT };
