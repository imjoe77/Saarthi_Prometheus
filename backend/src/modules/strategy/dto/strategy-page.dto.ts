import { ApiProperty } from '@nestjs/swagger';

import { PublicStrategyDto } from './public-strategy.dto';
import { StrategyResponseDto } from './strategy-response.dto';

/**
 * MODULE 05 - the two paginated envelopes, together.
 *
 * They live in one file because they are one decision. Both listings return the
 * same five keys in the same order, so a client paginates a user's own strategies
 * and the public catalogue with a single code path, and the only difference
 * between the two responses is the item type. Splitting them would make that
 * symmetry look accidental.
 *
 * The item types are not interchangeable, and cannot drift into being so: the
 * public one has no owner identity and no lifecycle fields to leak.
 */

/**
 * One page of the caller's own strategies.
 *
 * `total` is the count of rows matching the filters, not of the page, so a client
 * can render "showing 3 of 11" and decide whether to paginate at all. It costs
 * one `COUNT` per request; on a catalogue this small that is cheaper than the
 * alternative of a client guessing.
 *
 * `totalPages` is 0 for an empty result rather than 1, so a UI testing `> 0` does
 * not render an empty pager. An empty catalogue has no pages; it has rows: none.
 */
export class StrategyPageDto {
  @ApiProperty({ description: 'Strategies on this page, newest first.', type: [StrategyResponseDto] })
  items!: StrategyResponseDto[];

  @ApiProperty({ description: '1-based page number that was returned.', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size that was applied.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Total strategies matching the filters.', example: 11 })
  total!: number;

  @ApiProperty({ description: 'Number of pages at this page size. Zero when total is zero.', example: 1 })
  totalPages!: number;
}

/**
 * One page of the public catalogue: PUBLIC and ACTIVE strategies from every
 * account, newest first. Same envelope, narrower items — see
 * `PublicStrategyDto` for what was removed and why.
 */
export class PublicStrategyPageDto {
  @ApiProperty({ description: 'Public, active strategies on this page, newest first.', type: [PublicStrategyDto] })
  items!: PublicStrategyDto[];

  @ApiProperty({ description: '1-based page number that was returned.', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size that was applied.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Total public, active strategies.', example: 4 })
  total!: number;

  @ApiProperty({ description: 'Number of pages at this page size. Zero when total is zero.', example: 1 })
  totalPages!: number;
}
