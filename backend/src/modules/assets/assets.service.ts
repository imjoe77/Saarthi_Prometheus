import { Injectable } from '@nestjs/common';
import type { Asset } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';

/**
 * MODULE 03 — read-only access to the supported asset set.
 *
 * Assets are reference data seeded once and read everywhere. This service is
 * deliberately read-only: creating or retiring an asset is an operational act,
 * not something a request may do, and no route exposes it.
 *
 * It reads `prisma.asset` directly rather than through another feature module,
 * which is what lets `AssetsModule` and `WalletModule` stay independent while
 * sharing the same global `PrismaService`.
 */
@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every asset currently accepting movements, in stable symbol order.
   *
   * Inactive assets are omitted: they remain in the database so their history
   * stays reconcilable, but they are not offered as something to hold.
   */
  async listActive(): Promise<Asset[]> {
    return this.prisma.asset.findMany({
      where: { isActive: true },
      orderBy: { symbol: 'asc' },
    });
  }
}
