import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { PaperCursor, PaperExecutionPort, PaperFill } from './ports/paper-execution.port';

/**
 * MODULE 06c - the store that reads committed paper fills for followers.
 *
 * KEYSET CURSOR. Scanning by a synthetic `(filledAt, orderId)` avoids the usual
 * tie-breaker and off-by-one issues: two fills cannot share both keys, and the
 * comparison is fully indexable by `(strategy_id, status, filled_at)` and the
 * natural key order of `order_id`. The WHERE condition is `filledAt > cursor`
 * OR `(filledAt = cursor AND orderId > cursorOrderId)` when both are present.
 */
@Injectable()
export class PaperExecutionStore implements PaperExecutionPort {
  constructor(private readonly prisma: PrismaService) {}

  async fillsAfter(
    strategyId: string,
    cursorFilledAt: Date | null,
    cursorOrderId: string | null,
    limit: number,
  ): Promise<readonly PaperFill[]> {
    if (cursorFilledAt === null || cursorOrderId === null) {
      const rows = await this.prisma.paperOrder.findMany({
        where: { strategyId, status: 'FILLED', filledAt: { not: null } },
        orderBy: [{ filledAt: 'asc' }, { orderId: 'asc' }],
        take: limit,
      });
      return rows.map((row) => ({
        orderId: row.orderId,
        strategyId: row.strategyId,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        fillPrice: row.fillPrice!,
        filledAt: row.filledAt!,
      }));
    }

    const rows = await this.prisma.paperOrder.findMany({
      where: {
        strategyId,
        status: 'FILLED',
        filledAt: { not: null },
        OR: [
          { filledAt: { gt: cursorFilledAt } },
          { filledAt: cursorFilledAt, orderId: { gt: cursorOrderId } },
        ],
      },
      orderBy: [{ filledAt: 'asc' }, { orderId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      orderId: row.orderId,
      strategyId: row.strategyId,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      fillPrice: row.fillPrice!,
      filledAt: row.filledAt!,
    }));
  }

  /**
   * ONE QUERY FOR MANY CURSORS.
   *
   * The question is the same for every cursor - "is there a committed fill
   * after this point?" - and each one has its own strategy and its own
   * position in that strategy's history, so the filters differ per cursor but
   * the shape does not. One `OR` of one filter per cursor answers the whole
   * batch, and `distinct` reduces the answer to the strategies that actually
   * have something waiting.
   *
   * A NULL CURSOR MEANS "FROM THE BEGINNING", exactly as in `fillsAfter`: any
   * committed fill for that strategy counts as pending.
   */
  async pendingAfter(cursors: readonly PaperCursor[]): Promise<Set<string>> {
    if (cursors.length === 0) return new Set();

    const rows = await this.prisma.paperOrder.findMany({
      where: {
        status: 'FILLED',
        filledAt: { not: null },
        OR: cursors.map((cursor) => ({
          strategyId: cursor.strategyId,
          ...(cursor.cursorFilledAt === null || cursor.cursorOrderId === null
            ? {}
            : {
                OR: [
                  { filledAt: { gt: cursor.cursorFilledAt } },
                  { filledAt: cursor.cursorFilledAt, orderId: { gt: cursor.cursorOrderId } },
                ],
              }),
        })),
      },
      select: { strategyId: true },
      distinct: ['strategyId'],
    });

    return new Set(rows.map((row) => row.strategyId));
  }
}