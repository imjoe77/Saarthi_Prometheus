import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { PaperOrder } from '@prisma/client';
import { decimalString } from '../../market-data/domain/decimal-string';

export class PaperOrderResponseDto {
  @ApiProperty({ description: 'Server order id.', example: '1f4c4034-2cd1-40c3-b7dd-a88578418f66' })
  orderId!: string;

  @ApiProperty({ description: 'Strategy id.' })
  strategyId!: string;

  @ApiProperty({ description: 'Symbol.' })
  symbol!: string;

  @ApiProperty({ enum: ['BUY', 'SELL'] })
  side!: string;

  @ApiProperty({ description: 'Quantity as a string, exact.' })
  quantity!: string;

  @ApiProperty({ enum: ['FILLED', 'REJECTED'] })
  status!: string;

  @ApiPropertyOptional({ enum: ['MARKET_DATA_UNAVAILABLE', 'STALE_MARKET_DATA', 'MARKET_CLOSED', 'INSUFFICIENT_PAPER_CASH', 'INSUFFICIENT_POSITION'], nullable: true })
  rejectReason!: string | null;

  @ApiPropertyOptional({ nullable: true })
  fillPrice!: string | null;

  @ApiProperty()
  placedAt!: string;

  @ApiPropertyOptional({ nullable: true })
  filledAt!: string | null;

  @ApiProperty()
  clientRequestId!: string;

  static from(order: PaperOrder): PaperOrderResponseDto {
    return {
      orderId: order.orderId,
      strategyId: order.strategyId,
      symbol: order.symbol,
      side: order.side,
      quantity: decimalString(order.quantity),
      status: order.status,
      rejectReason: order.rejectReason ?? null,
      fillPrice: order.fillPrice ? decimalString(order.fillPrice) : null,
      placedAt: order.placedAt.toISOString(),
      filledAt: order.filledAt ? order.filledAt.toISOString() : null,
      clientRequestId: order.clientRequestId,
    };
  }
}