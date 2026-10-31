import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { PaperAccount, PaperPosition } from '@prisma/client';
import { decimalString } from '../../market-data/domain/decimal-string';

/** One open paper holding, exactly as the ledger stores it. */
export class PaperPositionResponseDto {
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

  static from(position: PaperPosition): PaperPositionResponseDto {
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
 * The paper cash account for one strategy.
 *
 * `realizedPnl` is the accumulated result of *closed* SELLs only. Unrealised
 * P&L is deliberately absent: it would require marking the position to a live
 * quote, and this response is a ledger read, not a valuation. The screen marks
 * positions itself using the quote it already fetched and labels it as such.
 */
export class PaperAccountResponseDto {
  @ApiProperty({ description: 'Quote currency of every paper balance.' })
  currency!: string;

  @ApiProperty({ description: 'Paper cash on hand, marked in USD. Never Module 03 money.' })
  cash!: string;

  @ApiProperty({ description: 'Accumulated realized P&L from closed SELLs, exact.' })
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
 * (null until the first order provisions it) and the open positions. Null is a
 * legitimate answer, not an error - a strategy that has never traded has no
 * paper account yet.
 */
export class PaperSummaryResponseDto {
  @ApiPropertyOptional({ type: PaperAccountResponseDto, nullable: true, description: 'Null before the first order.' })
  account!: PaperAccountResponseDto | null;

  @ApiProperty({ type: [PaperPositionResponseDto] })
  positions!: PaperPositionResponseDto[];
}
