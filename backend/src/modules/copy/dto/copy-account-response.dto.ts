import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CopyAccount, CopyPosition } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import type { CopyAggregateAccount, MarkedCopyPosition } from '../copy.service';

/**
 * One open copy holding for one follow, marked at the market.
 *
 * THE DIRECTION IS PART OF THE HOLDING. A position is a direction plus a
 * strictly positive quantity, so "0.5 AAPL" is not a fact on its own - it is
 * "0.5 AAPL long" or "0.5 AAPL short", and the two have opposite exposure to
 * the same price. The quantity is never signed; the direction carries the
 * sign instead.
 *
 * THE MARKS MAY BE NULL, AND NULL MEANS "NO PRICE", NOT "ZERO". When the feed
 * cannot price the instrument there is no honest market value to report, so
 * the value columns are null and `stale` says whether the last price was
 * already behind the market. A zero would claim the holding is worth nothing.
 */
export class CopyPositionResponseDto {
  @ApiProperty({ description: 'Symbol from the live-market catalogue.' })
  symbol!: string;

  @ApiProperty({ description: 'Which way this holding points.', enum: ['LONG', 'SHORT'] })
  direction!: 'LONG' | 'SHORT';

  @ApiProperty({ description: 'Base-asset units held, always > 0.' })
  quantity!: string;

  @ApiProperty({ description: 'Quantity-weighted average entry price.' })
  averageEntryPrice!: string;

  @ApiPropertyOptional({
    description: 'The quote this holding was marked at. Null when the feed had no price for it.',
    nullable: true,
  })
  markPrice!: string | null;

  @ApiPropertyOptional({
    description: 'Signed market value at the mark. Negative for a short, because the exposure is negative.',
    nullable: true,
  })
  marketValue!: string | null;

  @ApiPropertyOptional({
    description: 'Profit or loss on this holding if it were closed at the mark. Null when there is no mark.',
    nullable: true,
  })
  unrealizedPnl!: string | null;

  @ApiProperty({ description: 'True when the quote this holding was marked at is already behind the market.' })
  stale!: boolean;

  @ApiProperty()
  openedAt!: string;

  @ApiProperty()
  lastActivityAt!: string;

  static from(this: void, marked: MarkedCopyPosition): CopyPositionResponseDto {
    return {
      symbol: marked.position.symbol,
      direction: marked.position.direction,
      quantity: decimalString(marked.position.quantity),
      averageEntryPrice: decimalString(marked.position.averageEntryPrice),
      markPrice: marked.markPrice === null ? null : decimalString(marked.markPrice),
      marketValue: marked.marketValue === null ? null : decimalString(marked.marketValue),
      unrealizedPnl: marked.unrealizedPnl === null ? null : decimalString(marked.unrealizedPnl),
      stale: marked.stale,
      openedAt: marked.position.openedAt.toISOString(),
      lastActivityAt: marked.position.lastActivityAt.toISOString(),
    };
  }
}

/**
 * The copy cash pot for one follow.
 *
 * NULL BEFORE THE FIRST COPY, not zero. A follow that has never executed
 * anything has not spent anything, and reporting a balance would invite the
 * reader to wonder what happened to the rest of it; `null` says "no account
 * exists yet" in a way a zero cannot.
 *
 * The cash is simulated and separate from Module 03's wallet and from the
 * expert's paper account - three ledgers that must never be added together, so
 * this response names which one it is.
 */
export class CopyAccountResponseDto {
  @ApiProperty({ description: 'Quote currency of this copy balance.' })
  currency!: string;

  @ApiProperty({ description: 'Copy cash on hand, marked in USD. Never Module 03 money.' })
  cash!: string;

  @ApiProperty({ description: 'Accumulated realized P&L from closed positions, exact.' })
  realizedPnl!: string;

  @ApiProperty({ description: 'When this copy account was first provisioned.' })
  openedAt!: string;

  @ApiProperty({ description: 'When any copied fill last moved this account.' })
  lastActivityAt!: string;

  static from(this: void, account: CopyAccount): CopyAccountResponseDto {
    return {
      currency: account.currency,
      cash: decimalString(account.cash),
      realizedPnl: decimalString(account.realizedPnl),
      openedAt: account.openedAt.toISOString(),
      lastActivityAt: account.lastActivityAt.toISOString(),
    };
  }
}

/**
 * One follow's money: its pot (null before the first copy), its open
 * positions and the real wallet balance that gates any further copy.
 *
 * THE WALLET BALANCE TRAVELS WITH THE COPY BALANCE ON PURPOSE. The copy pot is
 * simulated and the wallet is real, and a reader who only saw the pot would
 * believe a follower could copy forever. The wallet figure is the gate: it is
 * what the engine checks before it copies anything.
 */
export class CopyFollowAccountResponseDto {
  @ApiPropertyOptional({ type: CopyAccountResponseDto, nullable: true, description: 'Null before the first copy.' })
  account!: CopyAccountResponseDto | null;

  @ApiProperty({ type: [CopyPositionResponseDto] })
  positions!: CopyPositionResponseDto[];

  @ApiProperty({
    description: "The caller's real, spendable USDT balance. The gate every further copy has to pass.",
  })
  walletUsdt!: string;
}

/** An aggregate holding: merged across follows, with its follow count. */
export class AggregatePositionResponseDto {
  @ApiProperty()
  symbol!: string;

  @ApiProperty({ description: 'Which way this holding points.', enum: ['LONG', 'SHORT'] })
  direction!: 'LONG' | 'SHORT';

  @ApiProperty({ description: 'Units held across every follow that holds this symbol in this direction.' })
  quantity!: string;

  @ApiProperty({ description: 'Quantity-weighted average entry price across those follows.' })
  averageEntryPrice!: string;

  @ApiPropertyOptional({
    description: 'The quote this holding was marked at. Null when the feed had no price for it.',
    nullable: true,
  })
  markPrice!: string | null;

  @ApiPropertyOptional({
    description: 'Signed market value at the mark. Null when there is no mark.',
    nullable: true,
  })
  marketValue!: string | null;

  @ApiPropertyOptional({
    description: 'Profit or loss on this holding if it were closed at the mark. Null when there is no mark.',
    nullable: true,
  })
  unrealizedPnl!: string | null;

  @ApiProperty({ description: 'True when the quote this holding was marked at is already behind the market.' })
  stale!: boolean;

  @ApiProperty({ description: 'How many separate follows contribute this holding.' })
  followCount!: number;
}

/**
 * The follower's copy money across every follow.
 *
 * `cash` is the SUM OF SEPARATE POTS, not one pooled account - which is why
 * `followCount` is part of the answer: a reader who sees 100,000 across two
 * follows should not take it to mean either follow could spend the whole sum.
 *
 * POSITIONS MERGE PER SYMBOL *AND DIRECTION*. Two experts can disagree about
 * the same instrument - one long, one short - and averaging those two into one
 * "AAPL" row would produce a number that describes neither position. A long
 * row and a short row are two facts about the book, and the aggregate keeps
 * them apart.
 *
 * THE HOLDINGS ARE PRICED. Each row carries the quote it was marked at, its
 * market value and its unrealised P&L, or nulls when the feed produced no
 * price at all.
 */
export class CopyAggregateAccountResponseDto {
  @ApiProperty({ description: 'How many follows contribute to these totals.' })
  followCount!: number;

  @ApiProperty({ description: 'Sum of every follow\'s copy cash.' })
  cash!: string;

  @ApiProperty({ description: 'Sum of every follow\'s realized P&L.' })
  realizedPnl!: string;

  @ApiProperty({ description: "The caller's real, spendable USDT balance. The gate every further copy has to pass." })
  walletUsdt!: string;

  @ApiProperty({ type: [AggregatePositionResponseDto] })
  positions!: AggregatePositionResponseDto[];

  static from(this: void, account: CopyAggregateAccount): CopyAggregateAccountResponseDto {
    return {
      followCount: account.followCount,
      cash: decimalString(account.cash),
      realizedPnl: decimalString(account.realizedPnl),
      walletUsdt: decimalString(account.walletUsdt),
      positions: account.positions.map((position) => ({
        symbol: position.symbol,
        direction: position.direction,
        quantity: decimalString(position.quantity),
        averageEntryPrice: decimalString(position.averageEntryPrice),
        markPrice: position.markPrice === null ? null : decimalString(position.markPrice),
        marketValue: position.marketValue === null ? null : decimalString(position.marketValue),
        unrealizedPnl: position.unrealizedPnl === null ? null : decimalString(position.unrealizedPnl),
        stale: position.stale,
        followCount: position.followCount,
      })),
    };
  }
}
