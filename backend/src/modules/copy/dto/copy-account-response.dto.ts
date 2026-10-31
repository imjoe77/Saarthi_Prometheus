import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CopyAccount, CopyPosition } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import type { CopyAggregateAccount } from '../copy.service';

/** One open copy holding for one follow, exactly as the ledger stores it. */
export class CopyPositionResponseDto {
  @ApiProperty({ description: 'Symbol from the live-market catalogue.' })
  symbol!: string;

  @ApiProperty({ description: 'Base-asset units held, always > 0.' })
  quantity!: string;

  @ApiProperty({ description: 'Quantity-weighted average entry price.' })
  averageEntryPrice!: string;

  @ApiProperty()
  openedAt!: string;

  @ApiProperty()
  lastActivityAt!: string;

  static from(this: void, position: CopyPosition): CopyPositionResponseDto {
    return {
      symbol: position.symbol,
      quantity: decimalString(position.quantity),
      averageEntryPrice: decimalString(position.averageEntryPrice),
      openedAt: position.openedAt.toISOString(),
      lastActivityAt: position.lastActivityAt.toISOString(),
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

  @ApiProperty({ description: 'Accumulated realized P&L from closed SELLs, exact.' })
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
 * One follow's money: its pot (null before the first copy) and its open
 * positions.
 */
export class CopyFollowAccountResponseDto {
  @ApiPropertyOptional({ type: CopyAccountResponseDto, nullable: true, description: 'Null before the first copy.' })
  account!: CopyAccountResponseDto | null;

  @ApiProperty({ type: [CopyPositionResponseDto] })
  positions!: CopyPositionResponseDto[];
}

/** An aggregate holding: merged across follows, with its follow count. */
export class AggregatePositionResponseDto {
  @ApiProperty()
  symbol!: string;

  @ApiProperty({ description: 'Units held across every follow that holds this symbol.' })
  quantity!: string;

  @ApiProperty({ description: 'Quantity-weighted average entry price across those follows.' })
  averageEntryPrice!: string;

  @ApiProperty({ description: 'How many separate follows contribute this holding.' })
  followCount!: number;
}

/**
 * The follower's copy money across every follow.
 *
 * `cash` is the SUM OF SEPARATE POTS, not one pooled account - which is why
 * `followCount` is part of the answer: a reader who sees 100,000 across two
 * follows should not take it to mean either follow could spend the whole sum.
 * Positions are merged per symbol with a quantity-weighted average, so the
 * figure equals what the per-follow rows would produce if read as one holding.
 *
 * No unrealised mark, for the same reason the paper account has none: this is a
 * ledger read, and pricing it would need a quote this module deliberately does
 * not fetch.
 */
export class CopyAggregateAccountResponseDto {
  @ApiProperty({ description: 'How many follows contribute to these totals.' })
  followCount!: number;

  @ApiProperty({ description: 'Sum of every follow\'s copy cash.' })
  cash!: string;

  @ApiProperty({ description: 'Sum of every follow\'s realized P&L.' })
  realizedPnl!: string;

  @ApiProperty({ type: [AggregatePositionResponseDto] })
  positions!: AggregatePositionResponseDto[];

  static from(this: void, account: CopyAggregateAccount): CopyAggregateAccountResponseDto {
    return {
      followCount: account.followCount,
      cash: decimalString(account.cash),
      realizedPnl: decimalString(account.realizedPnl),
      positions: account.positions.map((position) => ({
        symbol: position.symbol,
        quantity: decimalString(position.quantity),
        averageEntryPrice: decimalString(position.averageEntryPrice),
        followCount: position.followCount,
      })),
    };
  }
}
