import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { decimalString } from '../../market-data/domain/decimal-string';
import { type FollowRecord, type FollowerRecord } from '../copy.service';
import { evaluateEligibility } from '../domain/copy-sizing';

/**
 * MODULE 07 - what a follower sees about one follow.
 *
 * ELIGIBILITY IS DERIVED, NEVER STORED. The reason copying may or may not be
 * happening right now is recomputed from the follow and the strategy on every
 * read, because it is the one thing a screen must not show stale: a strategy
 * archived a second ago has to read as archived now, not at the last write.
 * It is returned instead of the raw `visibility`, so a private strategy reads as
 * `STRATEGY_NOT_ELIGIBLE` and nothing about who can see it leaks through this
 * route.
 *
 * COUNTS ARE OUTCOMES, NOT ORDERS. `copiedCount` is fills that moved the
 * follower's ledger; `rejectedCount` is fills that were consumed and refused.
 * The two together are everything the engine has seen for this follow, which is
 * what a follower needs to tell "nothing happened yet" from "everything was
 * refused".
 *
 * `hasPendingEvents` IS THE ONE LIVE FIELD. Everything else here is a stored
 * row or a rule applied to one; this is a question asked of the expert's
 * committed fills right now - is there something the engine has not consumed
 * yet? It is on the list as well as on the single-follow read, because a
 * follower who watches several experts wants to know which of them are behind
 * without opening each one in turn.
 */
export class FollowResponseDto {
  @ApiProperty({ description: 'Strategy being followed.' })
  strategyId!: string;

  @ApiProperty({ description: 'Name of the followed strategy, as the follower last saw it.' })
  strategyName!: string;

  @ApiProperty({ description: 'Lifecycle of the strategy.', enum: ['ACTIVE', 'ARCHIVED'] })
  strategyStatus!: 'ACTIVE' | 'ARCHIVED';

  @ApiProperty({
    description: 'Relationship state. Copying stops the moment this is UNFOLLOWED.',
    enum: ['ACTIVE', 'UNFOLLOWED'],
  })
  status!: 'ACTIVE' | 'UNFOLLOWED';

  @ApiProperty({
    description: 'Share of each expert order this follow mirrors, in (0, 1]. 1 mirrors the expert exactly.',
    example: '0.25',
  })
  allocationFraction!: string;

  @ApiProperty({
    description: 'When the current active interval began. Fills stamped before this are never copied.',
  })
  followedAt!: string;

  @ApiPropertyOptional({
    description: 'When the current unfollow began. Null while ACTIVE.',
    nullable: true,
  })
  unfollowedAt!: string | null;

  @ApiPropertyOptional({
    description: 'When the engine last consumed an event for this follow. Null until the first pass.',
    nullable: true,
  })
  lastProcessedAt!: string | null;

  @ApiProperty({ description: 'Committed expert fills that moved this follower ledger.', example: 3 })
  copiedCount!: number;

  @ApiProperty({ description: 'Committed expert fills seen and refused, each with a stored reason.', example: 1 })
  rejectedCount!: number;

  @ApiProperty({
    description:
      'Why this follow is or is not copying right now. ELIGIBLE, or the same vocabulary the copy history uses.',
    enum: [
      'ELIGIBLE',
      'FOLLOW_NOT_ACTIVE',
      'STRATEGY_ARCHIVED',
      'STRATEGY_NOT_ELIGIBLE',
      'ALLOCATION_ROUNDED_TO_ZERO',
      'INSUFFICIENT_COPY_CASH',
      'INSUFFICIENT_POSITION',
      'PRICE_UNAVAILABLE',
    ],
  })
  eligibility!: string;

  @ApiProperty({
    description:
      'True when the expert has committed a fill after this follow\'s cursor that the engine has not consumed yet.',
  })
  hasPendingEvents!: boolean;

  static from(this: void, record: FollowRecord): FollowResponseDto {
    const eligibility = evaluateEligibility({
      followStatus: record.follow.status,
      followedAt: record.follow.followedAt,
      fillFilledAt: new Date(),
      strategy: { status: record.strategy.status, visibility: record.strategy.visibility },
    });

    return {
      strategyId: record.strategy.id,
      strategyName: record.strategy.name,
      strategyStatus: record.strategy.status,
      status: record.follow.status,
      allocationFraction: decimalString(record.follow.allocationFraction),
      followedAt: record.follow.followedAt.toISOString(),
      unfollowedAt: record.follow.unfollowedAt?.toISOString() ?? null,
      lastProcessedAt: record.follow.lastProcessedAt?.toISOString() ?? null,
      copiedCount: record.copiedCount,
      rejectedCount: record.rejectedCount,
      eligibility: eligibility.eligible ? 'ELIGIBLE' : eligibility.rejectReason,
      hasPendingEvents: record.hasPendingEvents,
    };
  }
}

/**
 * One follower, as the strategy's owner sees them.
 *
 * THE ADDRESS IS MASKED HERE, AT THE BOUNDARY. `a***@example.com` keeps the
 * owner able to tell two followers apart by initial and domain while making the
 * address useless for contacting them - which is the difference between "who is
 * in my audience" and "whose email list did I just acquire". The unmasked value
 * never reaches this type.
 */
export class FollowerResponseDto {
  @ApiProperty({ description: 'Follower account, opaque to the owner.' })
  followerId!: string;

  @ApiProperty({ description: 'Masked follower address: first character plus the domain.', example: 'a***@example.com' })
  maskedEmail!: string;

  @ApiProperty({ description: 'Relationship state of this follow.', enum: ['ACTIVE', 'UNFOLLOWED'] })
  status!: 'ACTIVE' | 'UNFOLLOWED';

  @ApiProperty({ description: 'Allocation this follower configured, in (0, 1].', example: '0.25' })
  allocationFraction!: string;

  @ApiProperty({ description: 'When they started following.' })
  followedAt!: string;

  @ApiPropertyOptional({ description: 'When they unfollowed. Null while ACTIVE.', nullable: true })
  unfollowedAt!: string | null;

  @ApiProperty({ description: 'Expert fills copied for this follower.' })
  copiedCount!: number;

  @ApiProperty({ description: 'Expert fills refused for this follower.' })
  rejectedCount!: number;

  static from(this: void, record: FollowerRecord): FollowerResponseDto {
    return {
      followerId: record.follow.followerId,
      maskedEmail: record.maskedEmail,
      status: record.follow.status,
      allocationFraction: decimalString(record.follow.allocationFraction),
      followedAt: record.follow.followedAt.toISOString(),
      unfollowedAt: record.follow.unfollowedAt?.toISOString() ?? null,
      copiedCount: record.copiedCount,
      rejectedCount: record.rejectedCount,
    };
  }
}

/**
 * The five-key page envelope, identical to every other listing in the
 * application. `totalPages` is 0 for an empty result so a pager rendered on
 * `> 0` shows nothing rather than "page 1 of 0".
 *
 * One class per item type rather than a generic: Swagger cannot resolve a
 * generic's item type into a schema, and a documented page is worth more than
 * a deduplicated declaration.
 */
export class FollowPageDto {
  @ApiProperty({ type: [FollowResponseDto] })
  items!: FollowResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 4 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class FollowerPageDto {
  @ApiProperty({ type: [FollowerResponseDto] })
  items!: FollowerResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 4 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}
