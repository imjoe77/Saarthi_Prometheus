import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaperAccount, PaperOrder, PaperPosition } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { LiveDataService } from '../live-data/live-data.service';
import { markPosition } from '../trading/domain/position-book';

/**
 * One open holding, priced at the market.
 *
 * THE MARK IS A VALUATION, NOT A LEDGER FIGURE, AND THE DTO SAYS WHICH. A
 * position's stored quantity and average entry are facts; its market value is
 * the latest quote applied to them. `markPrice` is null when the feed produced
 * no price at all - and then `marketValue` and `unrealizedPnl` are null too,
 * because a value computed from a missing price would be a guess.
 *
 * `stale` is carried separately because a stale quote is still the last price
 * the market printed: after Friday's close, Friday's close is what the
 * position is worth. A reader who needs to know it is not live can see it; a
 * reader who needs a number still gets the honest one.
 */
export interface MarkedPosition {
  readonly position: PaperPosition;
  readonly markPrice: Prisma.Decimal | null;
  readonly marketValue: Prisma.Decimal | null;
  readonly unrealizedPnl: Prisma.Decimal | null;
  readonly stale: boolean;
}

/**
 * MODULE 06c - read surface for paper ledger, exported by the module for other
 * modules to query current account, positions and order history (owner-scoped).
 */
@Injectable()
export class PaperService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liveDataService: LiveDataService,
  ) {}

  async getAccount(strategyId: string): Promise<PaperAccount | null> {
    return this.prisma.paperAccount.findUnique({ where: { strategyId } });
  }

  async getPositions(strategyId: string): Promise<PaperPosition[]> {
    return this.prisma.paperPosition.findMany({ where: { strategyId }, orderBy: [{ openedAt: 'asc' }, { symbol: 'asc' }] });
  }

  async getOrders(strategyId: string, limit = 50): Promise<PaperOrder[]> {
    return this.prisma.paperOrder.findMany({
      where: { strategyId },
      orderBy: [{ placedAt: 'desc' }, { orderId: 'desc' }],
      take: limit,
    });
  }

  /**
   * The open positions, each priced at the latest quote for its symbol.
   *
   * ONE QUOTE PER SYMBOL, NOT PER POSITION. The feed's quotes are read live
   * rather than from a cache, so a book with three positions makes three quote
   * reads - one per symbol - and never six.
   */
  async getMarkedPositions(strategyId: string): Promise<MarkedPosition[]> {
    const positions = await this.getPositions(strategyId);
    const at = new Date();

    return Promise.all(
      positions.map(async (position) => {
        const quote = await this.liveDataService.quote(position.symbol, at);

        if (!quote.available || quote.price === null) {
          return {
            position,
            markPrice: null,
            marketValue: null,
            unrealizedPnl: null,
            stale: quote.stale,
          };
        }

        const markPrice = new Prisma.Decimal(quote.price);
        const marked = markPosition(
          {
            direction: position.direction,
            quantity: position.quantity,
            averageEntryPrice: position.averageEntryPrice,
          },
          markPrice,
        );

        return {
          position,
          markPrice,
          marketValue: marked.marketValue,
          unrealizedPnl: marked.unrealizedPnl,
          stale: quote.stale,
        };
      }),
    );
  }
}
