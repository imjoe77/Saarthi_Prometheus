import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TransactionType, WalletStatus } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import {
  CAPACITY_NOTE,
  RESERVE_FLOOR_BASE,
  RESERVE_FLOOR_PERCENT,
  RESERVE_NOTE,
  convertCapacityInrToUsdt,
  discretionaryCapacity,
  monthCapacityLeft,
  reserveFloor,
  reserveStatus,
  type CapacityConversion,
  type TreasuryCapacityExhaustion,
  type TreasuryReserveStatus,
} from './treasury-policy';

export { RESERVE_FLOOR_BASE, RESERVE_FLOOR_PERCENT, RESERVE_NOTE } from './treasury-policy';

export interface TreasuryBalanceBlock {
  available: string;
  locked: string;
  total: string;
}

export interface TreasuryReservePolicy {
  floorPercent: number;
  floorBase: string;
  floorBaseAmount: string | null;
  floorAmount: string | null;
  discretionaryCapacity: string | null;
  status: TreasuryReserveStatus;
  note: string;
}

export interface TreasuryUsdtCapacity {
  configured: boolean;
  demo: boolean;
  capacityInr: string | null;
  capacity: string | null;
  utilization: string;
  remaining: string | null;
  window: string;
  timezone: 'UTC';
  utilizationBasis: 'TREASURY_WALLET_USDT_OUTFLOWS';
  conversion: CapacityConversion | null;
  exhaustion: TreasuryCapacityExhaustion;
  note: string;
}

export interface TreasuryActivity {
  burns: { count: number; recordedEmber: string };
  buybacks: { count: number; executedCount: number; recordedEmber: string };
  allocations: { count: number };
}

export interface TreasurySummary {
  treasury: {
    email: string;
    provisioned: boolean;
    userId: string | null;
    walletId: string | null;
    walletStatus: WalletStatus | null;
  };
  ember: TreasuryBalanceBlock | null;
  usdt: TreasuryBalanceBlock | null;
  emberLifetimeFundedIn: string | null;
  reserve: TreasuryReservePolicy;
  usdtCapacity: TreasuryUsdtCapacity;
  activity: TreasuryActivity;
}

/**
 * The current UTC calendar month `[gte, lt)` plus its `YYYY-MM` label.
 *
 * UTC because the ledger stores `timestamptz` and a guardrail window that
 * shifted with the server's local timezone would make utilization
 * unreproducible between environments.
 */
export function utcMonthWindow(now: Date): { gte: Date; lt: Date; label: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    gte: new Date(Date.UTC(year, month, 1)),
    lt: new Date(Date.UTC(year, month + 1, 1)),
    label: `${year}-${String(month + 1).padStart(2, '0')}`,
  };
}

/**
 * MODULE 12 - the platform treasury's read model and USDT capacity tracking.
 *
 * Everything here is a READ. The dashboard must never move balances, so no
 * method in this service mutates the database - funding remains test/seed
 * only and there is deliberately no credit or mint route.
 *
 * The 30% reserve floor IS computed here, from the owner-approved base:
 * cumulative qualifying EMBER funding (DEPOSIT legs) on the treasury wallet,
 * summed from the append-only ledger. The floor the dashboard reports and
 * the floor Module 11's burn guard enforces come from the same
 * {@link reserveFloor} function, so the two can never disagree. The treasury
 * wallet's status is never transitioned by this module: enforcement is the
 * strict in-transaction check, not a status lever.
 *
 * Cross-module reads use the repository's existing precedent (Module 04
 * reads ledger tables read-only): burn/buyback/allocation figures here are
 * RECORD aggregates for display, never supply calculations - Module 10
 * remains the sole owner of supply, and Module 11's own records endpoints
 * remain the per-caller views.
 */
@Injectable()
export class TreasuryService {
  /** The platform treasury system account (Module 09's auto-register pattern). */
  private static readonly TREASURY_EMAIL = 'treasury@prometheus.local';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * The whole treasury dashboard payload, as of `now` (injectable so the
   * month window is deterministic under test).
   */
  async summary(now: Date = new Date()): Promise<TreasurySummary> {
    const user = await this.prisma.user.findUnique({
      where: { email: TreasuryService.TREASURY_EMAIL },
      select: { id: true },
    });
    const wallet = user
      ? await this.prisma.wallet.findUnique({
          where: { userId: user.id },
          select: { id: true, status: true },
        })
      : null;

    const provisioned = Boolean(user && wallet);
    const balances = provisioned ? await this.walletService.getBalances(user!.id) : [];

    const emberRow = balances.find((row) => row.asset.symbol === 'EMBER');
    const usdtRow = balances.find((row) => row.asset.symbol === 'USDT');

    const window = utcMonthWindow(now);

    const [fundedIn, qualifyingFunding, utilization, burns, buybackCounts, buybackEmber, allocations] =
      await Promise.all([
        this.emberFundedIn(wallet?.id ?? null),
        this.emberQualifyingFunding(wallet?.id ?? null),
        this.usdtUtilization(wallet?.id ?? null, window),
        this.prisma.tokenBurn.aggregate({
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.tokenBuyback.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.tokenBuyback.aggregate({ _sum: { executedEmber: true } }),
        this.prisma.tokenAllocation.count(),
      ]);

    const simulatedCount =
      buybackCounts.find((row) => row.status === 'SIMULATED')?._count._all ?? 0;
    const executedCount =
      buybackCounts.find((row) => row.status === 'RECORDED_SIMULATED_EXECUTION')?._count._all ?? 0;

    return {
      treasury: {
        email: TreasuryService.TREASURY_EMAIL,
        provisioned,
        userId: user?.id ?? null,
        walletId: wallet?.id ?? null,
        walletStatus: wallet?.status ?? null,
      },
      ember: emberRow
        ? {
            available: emberRow.available.toString(),
            locked: emberRow.locked.toString(),
            total: emberRow.available.add(emberRow.locked).toString(),
          }
        : null,
      usdt: usdtRow
        ? {
            available: usdtRow.available.toString(),
            locked: usdtRow.locked.toString(),
            total: usdtRow.available.add(usdtRow.locked).toString(),
          }
        : null,
      emberLifetimeFundedIn: fundedIn,
      reserve: this.buildReserve(provisioned, qualifyingFunding, emberRow?.available ?? null),
      usdtCapacity: this.buildUsdtCapacity(utilization, window.label),
      activity: {
        burns: {
          count: burns._count._all,
          recordedEmber: burns._sum.amount?.toString() ?? '0',
        },
        buybacks: {
          count: simulatedCount + executedCount,
          executedCount,
          recordedEmber: buybackEmber._sum.executedEmber?.toString() ?? '0',
        },
        allocations: { count: allocations },
      },
    };
  }

  /**
   * The reserve block: the approved 30% floor over the owner-approved base
   * (cumulative qualifying DEPOSIT funding), with the discretionary capacity
   * a burn may use. Unprovisioned reports nulls rather than fabricating a
   * treasury that does not exist yet.
   */
  private buildReserve(
    provisioned: boolean,
    qualifyingFunding: string | null,
    available: Prisma.Decimal | null,
  ): TreasuryReservePolicy {
    if (!provisioned || qualifyingFunding === null) {
      return {
        floorPercent: RESERVE_FLOOR_PERCENT,
        floorBase: RESERVE_FLOOR_BASE,
        floorBaseAmount: null,
        floorAmount: null,
        discretionaryCapacity: null,
        status: 'UNPROVISIONED',
        note: RESERVE_NOTE,
      };
    }

    const base = new Prisma.Decimal(qualifyingFunding);
    const floor = reserveFloor(base);
    const held = available ?? new Prisma.Decimal(0);

    return {
      floorPercent: RESERVE_FLOOR_PERCENT,
      floorBase: RESERVE_FLOOR_BASE,
      floorBaseAmount: base.toString(),
      floorAmount: floor.toString(),
      discretionaryCapacity: discretionaryCapacity(held, floor).toString(),
      status: reserveStatus(held, floor),
      note: RESERVE_NOTE,
    };
  }

  /**
   * The USDT capacity block: the approved demo capacity in INR, converted to
   * a USDT display ceiling at the configured display rate (never invented),
   * with utilization scoped exactly as before. Reporting-only by contract.
   */
  private buildUsdtCapacity(utilization: string, windowLabel: string): TreasuryUsdtCapacity {
    const capacityInr = this.config.treasury.monthlyCapacityInr;
    const shared = {
      window: windowLabel,
      timezone: 'UTC' as const,
      utilizationBasis: 'TREASURY_WALLET_USDT_OUTFLOWS' as const,
      note: CAPACITY_NOTE,
    };

    if (capacityInr === null) {
      return {
        configured: false,
        demo: false,
        capacityInr: null,
        capacity: null,
        utilization,
        remaining: null,
        conversion: null,
        exhaustion: 'NOT_CONFIGURED',
        ...shared,
      };
    }

    const { capacityUsdt, conversion } = convertCapacityInrToUsdt(
      new Prisma.Decimal(capacityInr),
      this.config.usdtPricing.fallbackPriceInr,
    );

    if (capacityUsdt === null) {
      return {
        configured: true,
        demo: true,
        capacityInr,
        capacity: null,
        utilization,
        remaining: null,
        conversion,
        exhaustion: 'UNAVAILABLE',
        ...shared,
      };
    }

    const { remaining, exhaustion } = monthCapacityLeft(capacityUsdt, utilization);
    return {
      configured: true,
      demo: true,
      capacityInr,
      capacity: capacityUsdt,
      utilization,
      remaining,
      conversion,
      exhaustion,
      ...shared,
    };
  }

  /**
   * Lifetime EMBER inflows to the treasury: DEPOSIT and TRANSFER_IN legs.
   *
   * Informational balance history for the dashboard - deliberately broader
   * than the reserve base, which counts qualifying DEPOSIT funding only
   * ({@link emberQualifyingFunding}). ADJUSTMENT is excluded because its
   * type carries no direction.
   */
  private async emberFundedIn(walletId: string | null): Promise<string | null> {
    if (!walletId) return null;

    const ember = await this.prisma.asset.findUnique({ where: { symbol: 'EMBER' } });
    if (!ember) return null;

    const inflow = await this.prisma.transaction.aggregate({
      where: {
        walletId,
        assetId: ember.id,
        type: { in: [TransactionType.DEPOSIT, TransactionType.TRANSFER_IN] },
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });

    return inflow._sum.amount?.toString() ?? '0';
  }

  /**
   * The reserve floor's base: cumulative qualifying EMBER funding - the
   * treasury wallet's COMPLETED `DEPOSIT` legs, summed from the append-only
   * ledger. Transfers and adjustments never qualify (Module 03 documents
   * them as separate classifications, and no rule promotes them to
   * funding); burns never reduce this historical basis.
   *
   * The same classification Module 11's burn guard aggregates in-transaction,
   * so the dashboard figure and the enforced figure are one definition.
   */
  private async emberQualifyingFunding(walletId: string | null): Promise<string | null> {
    if (!walletId) return null;

    const ember = await this.prisma.asset.findUnique({ where: { symbol: 'EMBER' } });
    if (!ember) return null;

    const funding = await this.prisma.transaction.aggregate({
      where: {
        walletId,
        assetId: ember.id,
        type: TransactionType.DEPOSIT,
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });

    return funding._sum.amount?.toString() ?? '0';
  }

  /**
   * Platform-treasury USDT outflows within the current UTC month:
   * WITHDRAWAL and TRANSFER_OUT legs on the treasury wallet only. Individual
   * users' transactions never contribute - the aggregate is scoped to the
   * treasury walletId - and with no treasury USDT spending operation in the
   * current architecture this stays at zero in practice.
   */
  private async usdtUtilization(
    walletId: string | null,
    window: { gte: Date; lt: Date },
  ): Promise<string> {
    if (!walletId) return '0';

    const usdt = await this.prisma.asset.findUnique({ where: { symbol: 'USDT' } });
    if (!usdt) return '0';

    const outflow = await this.prisma.transaction.aggregate({
      where: {
        walletId,
        assetId: usdt.id,
        type: { in: [TransactionType.WITHDRAWAL, TransactionType.TRANSFER_OUT] },
        status: 'COMPLETED',
        createdAt: { gte: window.gte, lt: window.lt },
      },
      _sum: { amount: true },
    });

    return outflow._sum.amount?.toString() ?? '0';
  }
}
