import { Injectable } from '@nestjs/common';
import { Prisma, type AssetKind } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import {
  emptyComposition,
  emptyTypeCounts,
  type PortfolioActivity,
  type PortfolioComposition,
  type PortfolioHolding,
  type PortfolioSnapshot,
} from './portfolio.types';

/**
 * One row as `WalletService` returns it: a balance with its asset inlined.
 *
 * Derived from the exported service's own signature rather than imported from
 * `wallet.types.ts`, so this module's only contact with the wallet is the public
 * API it is allowed to use.
 */
type BalanceWithAsset = Awaited<ReturnType<WalletService['getBalances']>>[number];

/**
 * MODULE 04 - the portfolio read model.
 *
 * A user's financial position, derived. This service owns no state: it reads
 * `wallet_balances` through `WalletService` and aggregates `transactions`
 * through the shared Prisma client, then returns the result. There is no
 * `portfolios` table, no cache and no stored total, so there is nothing here that
 * can drift out of step with the ledger.
 *
 * IT IS READ-ONLY, and that is a structural property rather than a convention:
 *
 *  - It never calls `credit`, `debit`, `lock` or `unlock`. Portfolio is not a
 *    second accounting path; every balance change in Prometheus still goes
 *    through the one accounting boundary.
 *  - It never writes `wallets`, `wallet_balances`, `transactions` or `assets`.
 *    The integration suite asserts this by fingerprinting those tables before
 *    and after a portfolio read.
 *
 * It reads `prisma.transaction` directly for its aggregates rather than asking
 * `WalletService` for them. Those are counts over a time window - portfolio
 * questions, not accounting questions - and adding read methods to the
 * accounting boundary for them would widen the one module that must stay small.
 *
 * WHAT IT DELIBERATELY DOES NOT COMPUTE:
 *
 *  - Valuation or net worth. No price source exists in this repository, so any
 *    monetary total would be invented. See `portfolio.types.ts`.
 *  - Allocation percentages across assets. The denominator would be a sum of
 *    incompatible units. Composition is counted per asset *category* instead.
 *  - P&L of any kind. The ledger records movements without acquisition costs, so
 *    neither realised nor unrealised P&L is derivable from it.
 *
 * QUERY COST: a fixed six statements per request - the wallet lookup, the balance
 * read (which resolves the wallet again, a second indexed lookup for a row this
 * service already holds), and three aggregates over the ledger. The count does not
 * vary with the number of holdings or movements, so there is no N+1 here.
 */

/** Rolling window for "recent activity". */
const MOVEMENT_WINDOW_DAYS = 30;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * Decimal places in a locked share. Four is enough to render a percentage and few
 * enough that the value cannot visibly wobble between two identical requests.
 */
const LOCKED_SHARE_PLACES = 4;

@Injectable()
export class PortfolioService {
  constructor(
    private readonly walletService: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Assembles one coherent snapshot of the caller's position.
   *
   * A user with no wallet yields an empty portfolio rather than a 404: the
   * portfolio resource always exists, it is simply empty, and answering with an
   * error would teach the client to treat a normal first-run state as a failure.
   *
   * `now` is a parameter so the activity window is deterministic under test
   * instead of depending on the wall clock.
   */
  async getSnapshot(userId: string, now: Date = new Date()): Promise<PortfolioSnapshot> {
    const wallet = await this.walletService.findForUser(userId);

    if (!wallet) {
      return {
        wallet: null,
        holdings: [],
        composition: emptyComposition(),
        activity: null,
        generatedAt: now,
      };
    }

    const balances = await this.walletService.getBalances(userId);
    const holdings = balances.map((balance) => this.toHolding(balance));

    return {
      wallet: { id: wallet.id, status: wallet.status, createdAt: wallet.createdAt },
      holdings,
      composition: this.summariseComposition(holdings),
      activity: await this.summariseActivity(wallet.id, now),
      generatedAt: now,
    };
  }

  /**
   * Expands one balance row into a holding.
   *
   * `total` is summed here in decimal arithmetic and nowhere else - never
   * persisted, so it cannot disagree with its own parts. The division only runs
   * when the total is positive, which is what keeps a drained holding from
   * producing `NaN` or `Infinity`.
   */
  private toHolding(balance: BalanceWithAsset): PortfolioHolding {
    const total = balance.available.plus(balance.locked);
    const isFunded = total.gt(0);

    return {
      asset: balance.asset,
      available: balance.available,
      locked: balance.locked,
      total,
      isFunded,
      lockedShare: isFunded ? this.toLockedShare(balance.locked, total) : null,
    };
  }

  /**
   * `locked / total` as a 0-1 number.
   *
   * Safe to convert to a JavaScript number precisely because it is a ratio of one
   * unit to itself: there is no currency being carried across, and the value is
   * pinned to four places before conversion so no precision question arises.
   */
  private toLockedShare(locked: Prisma.Decimal, total: Prisma.Decimal): number {
    return locked
      .div(total)
      .toDecimalPlaces(LOCKED_SHARE_PLACES, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
  }

  /**
   * Categorical composition: how many holdings, and how many of those are funded.
   *
   * `assetCount` counts balance rows, including drained ones - the user does hold
   * that asset, they simply hold none of it. `fundedAssetCount` is the subset with
   * a non-zero balance. Neither is a share of value, because no share of value can
   * be computed without prices.
   */
  private summariseComposition(holdings: readonly PortfolioHolding[]): PortfolioComposition {
    const byKind: Record<AssetKind, number> = { FIAT: 0, STABLECOIN: 0, TOKEN: 0 };
    let fundedAssetCount = 0;

    for (const holding of holdings) {
      byKind[holding.asset.kind] += 1;

      if (holding.isFunded) {
        fundedAssetCount += 1;
      }
    }

    return { assetCount: holdings.length, fundedAssetCount, byKind };
  }

  /**
   * Movement counts and the span they cover.
   *
   * Null when the ledger is empty, so the caller can say "no activity yet" instead
   * of rendering zeroes that read as data. Every `TransactionType` key is present
   * regardless, so the response shape never depends on which movements exist.
   */
  private async summariseActivity(walletId: string, now: Date): Promise<PortfolioActivity | null> {
    const windowStart = new Date(now.getTime() - MOVEMENT_WINDOW_DAYS * DAY_IN_MS);

    const [totals, withinWindow, byType] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { walletId },
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
      this.prisma.transaction.count({
        where: { walletId, createdAt: { gte: windowStart } },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { walletId },
        _count: { _all: true },
      }),
    ]);

    const totalMovements = totals._count._all;
    const firstMovementAt = totals._min.createdAt;
    const lastMovementAt = totals._max.createdAt;

    if (totalMovements === 0 || !firstMovementAt || !lastMovementAt) {
      return null;
    }

    const counts = emptyTypeCounts();

    for (const row of byType) {
      counts[row.type] = row._count._all;
    }

    return {
      totalMovements,
      movementsLast30Days: withinWindow,
      byType: counts,
      firstMovementAt: firstMovementAt.toISOString(),
      lastMovementAt: lastMovementAt.toISOString(),
    };
  }
}