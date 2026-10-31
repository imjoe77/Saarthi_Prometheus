import { ApiProperty } from '@nestjs/swagger';

import { BalanceResponseDto } from './balance-response.dto';
import { FillResponseDto } from './fill-response.dto';

/**
 * MODULE 06b - the page envelopes for fills and daily balances.
 *
 * The same five keys as every other listing in the application, in the same
 * order - Module 05 set the shape and there is no reason for a later module to
 * invent a sixth key or reorder the five. `totalPages` is 0 for an empty
 * result, for the same reason it is everywhere else: an empty list has no
 * pages, and a UI testing `> 0` should not render a pager over nothing.
 *
 * Two classes in one file because they are the same class twice: identical
 * envelope, item types that differ. Splitting them would suggest the envelopes
 * differ too.
 */
export class SimulationFillPageDto {
  @ApiProperty({
    description: 'Fills on this page, ascending by sequence.',
    type: [FillResponseDto],
  })
  items!: FillResponseDto[];

  @ApiProperty({ description: '1-based page number that was returned.', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size that was applied.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Total fills in the simulation.', example: 23 })
  total!: number;

  @ApiProperty({ description: 'Number of pages at this page size. Zero when total is zero.', example: 2 })
  totalPages!: number;
}

export class SimulationBalancePageDto {
  @ApiProperty({
    description: 'Daily balances on this page, ascending by day.',
    type: [BalanceResponseDto],
  })
  items!: BalanceResponseDto[];

  @ApiProperty({ description: '1-based page number that was returned.', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size that was applied.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Total days in the curve.', example: 644 })
  total!: number;

  @ApiProperty({ description: 'Number of pages at this page size. Zero when total is zero.', example: 33 })
  totalPages!: number;
}