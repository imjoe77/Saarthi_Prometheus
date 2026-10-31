import { ApiProperty } from '@nestjs/swagger';

import { CandleResponseDto } from './candle-response.dto';

/**
 * MODULE 06b - the page envelope for candle reads.
 *
 * The same five keys, in the same order, as Module 05's listings: `items`,
 * `page`, `limit`, `total`, `totalPages`. Two modules paging the same way is
 * worth more than either being tailored - a client that renders one catalogue
 * can render the other, and a reviewer checking one has already checked the
 * other. `totalPages` is 0 for an empty result rather than 1, so a UI testing
 * `> 0` does not render a pager for a window with no rows in it.
 *
 * `total` counts the rows the filters select, not the page. An empty page 3 of a
 * 40-row window is a client bug; an empty page 1 of a window that genuinely has
 * no rows is not, and only the total distinguishes them.
 */
export class CandlePageDto {
  @ApiProperty({
    description: 'Candles on this page, ascending by day.',
    type: [CandleResponseDto],
  })
  items!: CandleResponseDto[];

  @ApiProperty({ description: '1-based page number that was returned.', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size that was applied.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Total candles matching the filters.', example: 644 })
  total!: number;

  @ApiProperty({ description: 'Number of pages at this page size. Zero when total is zero.', example: 33 })
  totalPages!: number;
}
