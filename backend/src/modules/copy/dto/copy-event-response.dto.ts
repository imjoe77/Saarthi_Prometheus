import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CopyEvent } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import { FollowResponseDto } from './follow-response.dto';

/**
 * MODULE 07 - one consumed expert fill: what was copied, or why it was not.
 *
 * BOTH NUMBERS ARE PRESENT FOR A COPY AND BOTH ARE ABSENT FOR A REFUSAL. The
 * expert's committed quantity, price and stamp are always here - they are what
 * the engine saw. The follower's `quantity`, `fillPrice` and `gross` are null
 * (not zero) when the event was refused, because zero would be a fill of size
 * zero and a reader that forgets to check `status` would do arithmetic on a
 * decision.
 *
 * `rejectReason` uses exactly the vocabulary the sizing and eligibility rules
 * define, so a refusal in the history can be matched against the rule that
 * produced it without a lookup table.
 */
export class CopyEventResponseDto {
  @ApiProperty({ description: 'The strategy whose fill this event mirrors.' })
  strategyId!: string;

  @ApiProperty({ description: 'Name of the strategy whose fill this event mirrors.' })
  strategyName!: string;

  @ApiProperty({ description: 'Expert order this event mirrors. The idempotency key.' })
  expertOrderId!: string;

  @ApiProperty()
  symbol!: string;

  @ApiProperty({ description: 'Direction of the expert order.', enum: ['BUY', 'SELL'] })
  side!: 'BUY' | 'SELL';

  @ApiProperty({ description: 'Quantity the expert committed.' })
  expertQuantity!: string;

  @ApiPropertyOptional({
    description: 'Price the expert filled at. Null when the fill could not be priced (PRICE_UNAVAILABLE).',
    nullable: true,
  })
  expertFillPrice!: string | null;

  @ApiProperty({ description: 'When the expert\'s fill committed.' })
  expertFilledAt!: string;

  @ApiProperty({ description: 'Allocation in force when this event was consumed.', example: '0.25' })
  allocationFraction!: string;

  @ApiPropertyOptional({
    description: 'Quantity the follower executed. Null when REJECTED.',
    nullable: true,
  })
  quantity!: string | null;

  @ApiPropertyOptional({
    description: 'Price the follower executed at - the expert\'s fill price. Null when REJECTED.',
    nullable: true,
  })
  fillPrice!: string | null;

  @ApiPropertyOptional({
    description: 'quantity x fillPrice. Null when REJECTED.',
    nullable: true,
  })
  gross!: string | null;

  @ApiProperty({ description: 'Outcome.', enum: ['COPIED', 'REJECTED'] })
  status!: 'COPIED' | 'REJECTED';

  @ApiPropertyOptional({
    description: 'Why the fill was refused. Null when COPIED.',
    nullable: true,
    enum: [
      'FOLLOW_NOT_ACTIVE',
      'STRATEGY_ARCHIVED',
      'STRATEGY_NOT_ELIGIBLE',
      'ALLOCATION_ROUNDED_TO_ZERO',
      'INSUFFICIENT_COPY_CASH',
      'INSUFFICIENT_POSITION',
      'PRICE_UNAVAILABLE',
    ],
  })
  rejectReason!: string | null;

  @ApiProperty({ description: 'When the engine consumed this event.' })
  processedAt!: string;

  static from(this: void, event: CopyEvent, strategy: { id: string; name: string }): CopyEventResponseDto {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      expertOrderId: event.expertOrderId,
      symbol: event.symbol,
      side: event.side,
      expertQuantity: decimalString(event.expertQuantity),
      expertFillPrice: event.expertFillPrice === null ? null : decimalString(event.expertFillPrice),
      expertFilledAt: event.expertFilledAt.toISOString(),
      allocationFraction: decimalString(event.allocationFraction),
      // The column stores 0 for a refusal so a raw row can never read as a
      // fill, but the API reports `null`: "executed nothing" and "executed
      // zero" are different claims, and a reader adding up a history must not
      // find a zero-quantity line where a refusal was recorded.
      quantity: event.status === 'REJECTED' ? null : decimalString(event.quantity),
      fillPrice: event.fillPrice === null ? null : decimalString(event.fillPrice),
      gross: event.gross === null ? null : decimalString(event.gross),
      status: event.status,
      rejectReason: event.rejectReason,
      processedAt: event.processedAt.toISOString(),
    };
  }
}

/**
 * Copy history page: newest first, refusals included.
 *
 * Refusals are deliberately in the same list as copies rather than a separate
 * one. A follower reading only successful copies would see a gap where a fill
 * was refused and have no way to learn why - the history is the explanation.
 */
export class CopyEventPageDto {
  @ApiProperty({ type: [CopyEventResponseDto] })
  items!: CopyEventResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 12 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

/**
 * Result of the synchronous sync route: how many fills were consumed, plus the
 * follow's state immediately afterwards.
 *
 * Both halves are needed. `consumed` says whether the call did anything, and
 * the status that follows it says what the engine concluded - which is how a
 * screen shows "3 fills consumed, 1 refused for insufficient cash" in one round
 * trip instead of asking again.
 */
export class CopySyncResponseDto {
  @ApiProperty({ description: 'Events written by this call (copied or refused).', example: 2 })
  consumed!: number;

  @ApiProperty({ type: FollowResponseDto })
  status!: FollowResponseDto;
}
