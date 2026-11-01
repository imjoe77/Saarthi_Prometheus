import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { PaperAccount } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import type { MarkedPosition } from '../paper.service';

/**
 * One open paper holding, priced at the market.
 *
 * `direction` says which way the holding points and `quantity` is its
 * magnitude, always greater than zero. The three marked figures are null
 * together: without a price there is no market value and no unrealised P&L,
 * and a zero would claim the position is worth nothing rather than that it
 * could not be priced.
 */
export class PaperPositionResponseDto {
  @ApiProperty({ description: 'Symbol from the live-market catalogue.' })
  symbol!: string;

  @ApiProperty({ description: 'Which way this holding points.', enum: ['LONG', 'SHORT'] })
  direction!: string;

  @ApiProperty({ description: 'Base-asset units held, always > 0.' })
  quantity!: string;

  @ApiProperty({ description: 'Quantity-weighted average entry price.' })
  averageEntryPrice!: string;

  @ApiPropertyOptional({
    description: 'The quote the position was marked at. Null when the feed produced no price.',
    nullable: true,
  })
  markPrice!: string | null;

  @ApiPropertyOptional({
    description: 'Quantity x mark, signed: a short position is a liability, so its value is negative.',
    nullable: true,
  })
  marketValue!: string | null;

  @ApiPropertyOptional({
    description: 'Profit or loss on the open position at the mark. Null when it could not be marked.',
    nullable: true,
  })
  unrealizedPnl!: string | null;

  @ApiProperty({ description: 'True when the mark is older than the instrument\'s freshness threshold.' })
  stale!: boolean;

  @ApiProperty()
  openedAt!: string;

  @ApiProperty()
  lastActivityAt!: string;

  static from(marked: MarkedPosition): PaperPositionResponseDto {
    const { position } = marked;

    return {
      symbol: position.symbol,
      direction: position.direction,
      quantity: decimalString(position.quantity),
      averageEntryPrice: decimalString(position.averageEntryPrice),
      markPrice: marked.markPrice === null ? null : decimalString(marked.markPrice),
      marketValue: marked.marketValue === null ? null : decimalString(marked.marketValue),
      unrealizedPnl: marked.unrealizedPnl === null ? null : decimalString(marked.unrealizedPnl),
      stale: marked.stale,
      openedAt: position.openedAt.toISOString(),
      lastActivityAt: position.lastActivityAt.toISOString(),
    };
  }
}

/**
 * The paper cash account for one strategy.
 *
 * `realizedPnl` is the accumulated result of the closes this account made. The
 * unrealised half lives on the positions, where the mark is - this response is
 * the account's own ledger.
 */
export class PaperAccountResponseDto {
  @ApiProperty({ description: 'Quote currency of every paper balance.' })
  currency!: string;

  @ApiProperty({ description: 'Paper cash on hand, marked in USD. Never Module 03 money.' })
  cash!: string;

  @ApiProperty({ description: 'Accumulated realized P&L from closed positions, exact.' })
  realizedPnl!: string;

  @ApiProperty({ description: 'When this paper account was first provisioned.' })
  openedAt!: string;

  @ApiProperty({ description: 'When any order last mutated the account.' })
  lastActivityAt!: string;

  static from(account: PaperAccount): PaperAccountResponseDto {
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
 * Everything the expert's account panel needs in one read: the cash account
 * (null until the first order provisions it), the open positions marked at the
 * market, and the trader's real USDT balance - the capital gate every order
 * has to pass.
 *
 * Null is a legitimate answer, not an error - a strategy that has never traded
 * has no paper account yet.
 */
export class PaperSummaryResponseDto {
  @ApiPropertyOptional({ type: PaperAccountResponseDto, nullable: true, description: 'Null before the first order.' })
  account!: PaperAccountResponseDto | null;

  @ApiProperty({ type: [PaperPositionResponseDto] })
  positions!: PaperPositionResponseDto[];

  @ApiProperty({
    description: "The trader's real USDT balance. Every order's notional must be covered by it.",
  })
  walletUsdt!: string;

  static from(input: {
    account: PaperAccount | null;
    positions: MarkedPosition[];
    walletUsdt: Prisma.Decimal;
  }): PaperSummaryResponseDto {
    return {
      account: input.account === null ? null : PaperAccountResponseDto.from(input.account),
      positions: input.positions.map((position) => PaperPositionResponseDto.from(position)),
      walletUsdt: decimalString(input.walletUsdt),
    };
  }
}
