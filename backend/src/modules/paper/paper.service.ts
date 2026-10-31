import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { PaperAccount, PaperOrder, PaperPosition } from '@prisma/client';

/**
 * MODULE 06c - read surface for paper ledger, exported by the module for other
 * modules to query current account, positions and order history (owner-scoped).
 */
@Injectable()
export class PaperService {
  constructor(private readonly prisma: PrismaService) {}

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
}