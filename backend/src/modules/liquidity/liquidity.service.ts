import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  LiquidityCommitmentStatus,
  LiquidityProviderStatus,
  LiquidityTopUpStatus,
  Prisma,
  type Asset,
  type LiquidityAllocation,
  type LiquidityCommitment,
  type LiquidityCommitmentReduction,
  type LiquidityProvider,
  type LiquidityTopUpRequest,
} from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { normaliseAmount } from '../wallet/decimal.util';
import { WalletService } from '../wallet/wallet.service';
import { emberLockDelta, requiredEmberLock, slabsConfigured } from './domain/ember-slabs';
import type { LiquidityCommitmentReduceDto } from './dto/liquidity-commitment-reduce.dto';
import type { LiquidityCommitmentWriteDto } from './dto/liquidity-commitment-write.dto';

/** One provider's share of the pool, in percent (2 dp) - 0 when the base is 0. */
type SharePct = Prisma.Decimal;

/** Aggregated contribution of one commitment across every allocation slice. */
export interface LiquidityContributionTotals {
  contributedUsdt: Prisma.Decimal;
  contributedInr: Prisma.Decimal;
  allocationCount: number;
  ordersFunded: number;
  lastAllocatedAt: Date | null;
}

/**
 * Platform-wide distribution read rows (admin surface).
 *
 * `shareOfCommittedPct` answers "how much of all pledged USDT did this LP put
 * in"; `shareOfAvailablePct` answers "how much of what is still allocatable
 * sits with this LP right now". Both are computed against the same totals the
 * response carries, so the shares always sum to ~100 over non-zero rows.
 */
export interface LiquidityProviderDistributionRow {
  lpId: string;
  userId: string;
  email: string;
  status: LiquidityProviderStatus;
  registeredAt: Date;
  commitment: LiquidityCommitment | null;
  contributedUsdt: Prisma.Decimal;
  contributedInr: Prisma.Decimal;
  allocationCount: number;
  ordersFunded: number;
  lastAllocatedAt: Date | null;
  reducedUsdt: Prisma.Decimal;
  shareOfCommittedPct: SharePct;
  shareOfAvailablePct: SharePct;
  wallet: { available: Prisma.Decimal; locked: Prisma.Decimal } | null;
}

/** One recent allocation slice, with the order and provider it belongs to. */
export interface LiquidityRecentAllocationRow {
  allocationId: string;
  orderId: string;
  orderSide: string;
  orderUsdtAmount: Prisma.Decimal;
  commitmentId: string;
  lpId: string;
  providerEmail: string;
  usdtAmount: Prisma.Decimal;
  priceInr: Prisma.Decimal;
  inrAmount: Prisma.Decimal;
  allocatedAt: Date;
}

/** Aggregate pool facts behind the distribution table. */
export interface LiquidityDistributionTotals {
  totalCommittedUsdt: Prisma.Decimal;
  totalDistributedUsdt: Prisma.Decimal;
  totalRemainingUsdt: Prisma.Decimal;
  totalWithdrawnUsdt: Prisma.Decimal;
  distributedInr: Prisma.Decimal;
  allocationCount: number;
  ordersFunded: number;
  providerCount: number;
  activeProviderCount: number;
  activeRemainingUsdt: Prisma.Decimal;
  thresholdUsdt: Prisma.Decimal;
  shortfallUsdt: Prisma.Decimal;
  belowThreshold: boolean;
  commitmentsEnabled: boolean;
}

/**
 * MODULE 09 — simulated liquidity providers, commitments and shortfall
 * detection.
 *
 * PROVIDERS are application users who pledge USDT (auto-registered on first
 * commitment). Their pledged USDT stays in their own Module 03 wallet; the
 * commitment row is the eligibility ledger BUY orders draw from, guarded by
 * `usdt_available` the same way wallet balances are.
 *
 * EMBER GATING: every create and increase recomputes the flat-cliff slab
 * requirement and moves only the delta through `WalletService.lock` inside the
 * caller's transaction, so the commitment row and its lock commit together.
 * With NO slabs approved configured, every mutation refuses 503 - a locking
 * requirement is a business decision this service will not invent.
 *
 * CONCURRENCY: per-logical-key `pg_advisory_xact_lock` serialises operations
 * on one LP's commitment (create vs reduce vs overview upkeep), while guarded
 * `updateMany` writes remain the final arbiter - the same two-layer pattern
 * the copy and paper modules use instead of row locks.
 *
 * IDEMPOTENCY: create/increase stores `clientRequestId` on the commitment (the
 * most recent key wins, so a double-submitted request replays instead of
 * applying twice); reductions are idempotent on their own ledger row.
 *
 * REDUCTION POLICY (approved): withdraw anytime down to what orders consumed
 * (`usdtAvailable` never below zero), recompute the slab requirement, unlock
 * only the surplus above it. Closing to zero releases the lock entirely;
 * reduction below the lowest slab (allowed for withdrawal) requires nothing.
 */
@Injectable()
export class LiquidityService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  // ---------------------------------------------------------------------------
  // Commitments
  // ---------------------------------------------------------------------------

  /**
   * Opens the caller's single commitment, or increases it idempotently.
   *
   * Auto-registers the LP (and ensures their wallet) before the transaction,
   * then under the LP's advisory lock either replays a recognised key,
   * increases the existing row (locking only the EMBER delta), or creates the
   * first row. The slab must exist: below the lowest configured threshold is a
   * validation refusal, not an invented zero lock.
   */
  async createCommitment(
    userId: string,
    dto: LiquidityCommitmentWriteDto,
  ): Promise<{ commitment: LiquidityCommitment; created: boolean; replayed: boolean }> {
    const slabs = this.requireSlabs();

    const usdtAsset = await this.requireAsset('USDT');
    const emberAsset = await this.requireAsset('EMBER');
    const amount = normaliseAmount(dto.usdtAmount, usdtAsset);
    const { wallet } = await this.walletService.getOrCreateForUser(userId);
    const commitmentId = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      await this.lockLiquidityKey(tx, `liquidity_commitment:${userId}`);

      // One LP row per user; the upsert also makes registration concurrent-safe.
      const provider = await tx.liquidityProvider.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });

      const existing = await tx.liquidityCommitment.findUnique({ where: { lpId: provider.lpId } });

      if (existing && existing.clientRequestId === dto.clientRequestId) {
        return { commitment: existing, created: false, replayed: true };
      }

      const committedTotal = (existing?.usdtCommitted ?? new Prisma.Decimal(0)).add(amount);
      const required = requiredEmberLock(slabs, committedTotal);
      if (!required) {
        throw DomainException.badRequest(
          'A commitment must be at or above the lowest configured EMBER slab to qualify; nothing was locked.',
        );
      }

      const currentlyLocked = existing?.emberLocked ?? new Prisma.Decimal(0);
      const delta = emberLockDelta(currentlyLocked, required);
      const targetCommitmentId = existing?.commitmentId ?? commitmentId;

      if (delta.direction === 'lock') {
        await this.walletService.lock(
          wallet.id,
          emberAsset.id,
          delta.amount,
          { note: `EMBER locked for liquidity commitment ${targetCommitmentId}` },
          tx,
        );
      } else if (delta.direction === 'unlock') {
        // Defensive: a pure increase cannot lower the requirement, but a
        // consistent service still moves the wallet by exactly the delta.
        await this.walletService.unlock(
          wallet.id,
          emberAsset.id,
          delta.amount,
          { note: `EMBER unlocked for liquidity commitment ${targetCommitmentId}` },
          tx,
        );
      }

      if (existing) {
        const commitment = await tx.liquidityCommitment.update({
          where: { commitmentId: existing.commitmentId },
          data: {
            usdtCommitted: committedTotal,
            usdtAvailable: { increment: amount },
            emberLocked: required,
            clientRequestId: dto.clientRequestId,
            ...(existing.status === LiquidityCommitmentStatus.CLOSED
              ? { status: LiquidityCommitmentStatus.ACTIVE, closedAt: null }
              : {}),
          },
        });
        return { commitment, created: false, replayed: false };
      }

      const commitment = await tx.liquidityCommitment.create({
        data: {
          commitmentId,
          lpId: provider.lpId,
          usdtCommitted: amount,
          usdtConsumed: new Prisma.Decimal(0),
          usdtAvailable: amount,
          emberLocked: required,
          clientRequestId: dto.clientRequestId,
        },
      });
      return { commitment, created: true, replayed: false };
    });
  }

  /**
   * Withdraws USDT from the caller's own commitment under the same advisory
   * lock, releasing only the EMBER surplus above the new requirement.
   */
  async reduceCommitment(
    userId: string,
    dto: LiquidityCommitmentReduceDto,
  ): Promise<{ reduction: LiquidityCommitmentReduction; replayed: boolean }> {
    const slabs = this.requireSlabs();

    const usdtAsset = await this.requireAsset('USDT');
    const emberAsset = await this.requireAsset('EMBER');
    const amount = normaliseAmount(dto.usdtAmount, usdtAsset);

    // Resolve ownership outside the transaction purely to key the advisory
    // lock; it is re-checked under the lock before anything is written.
    const owner = await this.prisma.liquidityCommitment.findUnique({
      where: { commitmentId: dto.commitmentId },
      select: { lp: { select: { userId: true } } },
    });
    if (!owner || owner.lp.userId !== userId) {
      throw DomainException.notFound('LiquidityCommitment', dto.commitmentId);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockLiquidityKey(tx, `liquidity_commitment:${userId}`);

      const replay = await tx.liquidityCommitmentReduction.findUnique({
        where: {
          commitmentId_clientRequestId: {
            commitmentId: dto.commitmentId,
            clientRequestId: dto.clientRequestId,
          },
        },
      });
      if (replay) {
        return { reduction: replay, replayed: true };
      }

      const commitment = await tx.liquidityCommitment.findUniqueOrThrow({
        where: { commitmentId: dto.commitmentId },
        include: { lp: { select: { userId: true } } },
      });
      if (commitment.lp.userId !== userId) {
        throw DomainException.notFound('LiquidityCommitment', dto.commitmentId);
      }
      if (commitment.status === LiquidityCommitmentStatus.CLOSED) {
        throw DomainException.conflict('This commitment is closed; there is nothing left to reduce.');
      }
      if (amount.gt(commitment.usdtAvailable)) {
        throw DomainException.conflict(
          `A commitment cannot be reduced below the liquidity its orders already consumed (available ${commitment.usdtAvailable.toFixed(6)} USDT).`,
        );
      }

      const newCommitted = commitment.usdtCommitted.sub(amount);
      const closing = newCommitted.isZero();
      // Full withdrawal releases the lock entirely; any residue must at least
      // cover the slab it still qualifies for (null means below the lowest
      // slab, which only a withdrawal can be).
      const required = closing
        ? new Prisma.Decimal(0)
        : (requiredEmberLock(slabs, newCommitted) ?? new Prisma.Decimal(0));
      const surplus = commitment.emberLocked.sub(required);
      const unlockAmount = surplus.isNegative() ? new Prisma.Decimal(0) : surplus;

      if (unlockAmount.gt(0)) {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) {
          throw DomainException.notFound('Wallet');
        }
        await this.walletService.unlock(
          wallet.id,
          emberAsset.id,
          unlockAmount,
          { note: `EMBER unlocked for liquidity commitment ${commitment.commitmentId}` },
          tx,
        );
      }

      const guarded = await tx.liquidityCommitment.updateMany({
        where: {
          commitmentId: commitment.commitmentId,
          status: LiquidityCommitmentStatus.ACTIVE,
          usdtAvailable: { gte: amount },
        },
        data: {
          usdtCommitted: { decrement: amount },
          usdtAvailable: { decrement: amount },
          emberLocked: required,
          ...(closing
            ? { status: LiquidityCommitmentStatus.CLOSED, closedAt: new Date() }
            : {}),
        },
      });
      if (guarded.count === 0) {
        throw DomainException.conflict(
          'The commitment changed while this reduction was in flight; nothing was withdrawn. Retry with a new clientRequestId.',
        );
      }

      const reduction = await tx.liquidityCommitmentReduction.create({
        data: {
          commitmentId: commitment.commitmentId,
          usdtAmount: amount,
          emberUnlocked: unlockAmount,
          clientRequestId: dto.clientRequestId,
        },
      });

      return { reduction, replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Reads and shortfall detection
  // ---------------------------------------------------------------------------

  /** The caller's LP registration and commitment, either null when absent. */
  async getMyCommitment(
    userId: string,
  ): Promise<{
    provider: LiquidityProvider | null;
    commitment: LiquidityCommitment | null;
    commitmentsEnabled: boolean;
  }> {
    const commitmentsEnabled = slabsConfigured(this.config.liquidity.emberSlabs);
    const provider = await this.prisma.liquidityProvider.findUnique({ where: { userId } });
    if (!provider) {
      return { provider: null, commitment: null, commitmentsEnabled };
    }

    const commitment = await this.prisma.liquidityCommitment.findUnique({ where: { lpId: provider.lpId } });
    return { provider, commitment, commitmentsEnabled };
  }

  /**
   * The approved EMBER-locking slabs, ascending by the USDT they cover.
   *
   * Configuration, read from the same list the commitment path resolves
   * against, so a client that shows the table is showing the rule the server
   * will actually apply - never a second copy of it.
   */
  getSlabs(): { commitmentsEnabled: boolean; slabs: { minUsdt: string; requiredEmber: string }[] } {
    const slabs = [...this.config.liquidity.emberSlabs].sort(
      (left, right) => Number(left.minUsdt) - Number(right.minUsdt),
    );

    return {
      commitmentsEnabled: slabsConfigured(slabs),
      slabs: slabs.map((slab) => ({ minUsdt: slab.minUsdt, requiredEmber: slab.requiredEmber })),
    };
  }

  /**
   * Aggregate eligible liquidity against the configured threshold, persisting
   * at most one OPEN shortfall notice per detection cycle. Detection moves no
   * funds: the notice records the numbers, and fulfilling it is a normal
   * commitment increase by whichever LP acts.
   */
  async getOverview(): Promise<{
    aggregate: Prisma.Decimal;
    threshold: Prisma.Decimal;
    shortfall: Prisma.Decimal;
    belowThreshold: boolean;
    commitmentsEnabled: boolean;
    openRequest: LiquidityTopUpRequest | null;
  }> {
    const threshold = new Prisma.Decimal(this.config.liquidity.minAvailableUsdt);

    const aggregateSum = await this.prisma.liquidityCommitment.aggregate({
      where: {
        status: LiquidityCommitmentStatus.ACTIVE,
        lp: { status: LiquidityProviderStatus.ACTIVE },
      },
      _sum: { usdtAvailable: true },
    });
    const aggregate = aggregateSum._sum.usdtAvailable ?? new Prisma.Decimal(0);

    const difference = threshold.sub(aggregate);
    // Strictly below: an aggregate exactly equal to the threshold is met, not short.
    const belowThreshold = difference.gt(0);
    const shortfall = difference.isNegative() ? new Prisma.Decimal(0) : difference;

    const openRequest = await this.prisma.$transaction(async (tx) => {
      await this.lockLiquidityKey(tx, 'liquidity_topup');

      const open = await tx.liquidityTopUpRequest.findFirst({
        where: { status: LiquidityTopUpStatus.OPEN },
        orderBy: [{ openedAt: 'asc' }, { topUpRequestId: 'asc' }],
      });

      if (belowThreshold && !open) {
        return tx.liquidityTopUpRequest.create({
          data: { requiredUsdt: shortfall, thresholdUsdt: threshold },
        });
      }
      if (!belowThreshold && open) {
        await tx.liquidityTopUpRequest.update({
          where: { topUpRequestId: open.topUpRequestId },
          data: { status: LiquidityTopUpStatus.FULFILLED, resolvedAt: new Date() },
        });
        return null;
      }
      return open;
    });

    return {
      aggregate,
      threshold,
      shortfall,
      belowThreshold,
      commitmentsEnabled: slabsConfigured(this.config.liquidity.emberSlabs),
      openRequest,
    };
  }

  /** Shortfall notices, most recently opened first. */
  listTopUps(): Promise<LiquidityTopUpRequest[]> {
    return this.prisma.liquidityTopUpRequest.findMany({
      orderBy: [{ openedAt: 'desc' }, { topUpRequestId: 'desc' }],
      take: 100,
    });
  }

  /** The caller's own order's allocation slices (SELL or legacy orders: empty). */
  async listAllocations(userId: string, orderId: string): Promise<LiquidityAllocation[]> {
    const order = await this.prisma.usdtOrder.findUnique({ where: { orderId } });
    if (!order || order.userId !== userId) {
      throw DomainException.notFound('UsdtOrder', orderId);
    }

    return this.prisma.liquidityAllocation.findMany({
      where: { orderId },
      orderBy: { allocatedAt: 'asc' },
    });
  }

  /**
   * How USDT is distributed across every liquidity provider, for the admin
   * surface: each LP's pledge, what its commitment actually delivered to
   * customer orders (USDT, INR, order count), and what remains allocatable
   * after all distributions and reductions - plus pool totals against the
   * configured threshold and the most recent slices.
   *
   * Strictly read-only. Unlike `getOverview` this never opens or fulfils a
   * shortfall notice: an administrator refreshing the page must not move
   * state, so every number is derived from the three ledgers the allocation
   * engine already writes (commitments, allocation slices, reductions).
   */
  async getDistribution(): Promise<{
    totals: LiquidityDistributionTotals;
    providers: LiquidityProviderDistributionRow[];
    recentAllocations: LiquidityRecentAllocationRow[];
  }> {
    const threshold = new Prisma.Decimal(this.config.liquidity.minAvailableUsdt);
    const commitmentsEnabled = slabsConfigured(this.config.liquidity.emberSlabs);

    const providers = await this.prisma.liquidityProvider.findMany({
      include: {
        user: { select: { id: true, email: true } },
        commitment: true,
      },
      orderBy: { registeredAt: 'asc' },
    });

    const slices = await this.prisma.liquidityAllocation.findMany({
      select: {
        allocationId: true,
        commitmentId: true,
        orderId: true,
        usdtAmount: true,
        priceInr: true,
        allocatedAt: true,
      },
    });

    const reductions = await this.prisma.liquidityCommitmentReduction.findMany({
      select: { commitmentId: true, usdtAmount: true },
    });

    const userIds = providers.map((provider) => provider.userId);
    const walletRows = userIds.length
      ? await this.prisma.walletBalance.findMany({
          where: { asset: { symbol: 'USDT' }, wallet: { userId: { in: userIds } } },
          select: { available: true, locked: true, wallet: { select: { userId: true } } },
        })
      : [];
    const walletByUser = new Map(walletRows.map((row) => [row.wallet.userId, row]));

    // One pass over the slices: per-commitment contribution and pool-wide
    // distribution totals, so both always agree with the same source rows.
    const contributionByCommitment = new Map<string, LiquidityContributionTotals>();
    const ordersByCommitment = new Map<string, Set<string>>();
    let distributedInr = new Prisma.Decimal(0);
    const fundedOrders = new Set<string>();
    for (const slice of slices) {
      const entry = contributionByCommitment.get(slice.commitmentId) ?? {
        contributedUsdt: new Prisma.Decimal(0),
        contributedInr: new Prisma.Decimal(0),
        allocationCount: 0,
        ordersFunded: 0,
        lastAllocatedAt: null,
      };
      const inrValue = slice.usdtAmount.mul(slice.priceInr);
      entry.contributedUsdt = entry.contributedUsdt.add(slice.usdtAmount);
      entry.contributedInr = entry.contributedInr.add(inrValue);
      entry.allocationCount += 1;
      if (!entry.lastAllocatedAt || slice.allocatedAt > entry.lastAllocatedAt) {
        entry.lastAllocatedAt = slice.allocatedAt;
      }
      contributionByCommitment.set(slice.commitmentId, entry);

      const funded = ordersByCommitment.get(slice.commitmentId) ?? new Set<string>();
      funded.add(slice.orderId);
      ordersByCommitment.set(slice.commitmentId, funded);

      distributedInr = distributedInr.add(inrValue);
      fundedOrders.add(slice.orderId);
    }
    for (const [commitmentId, funded] of ordersByCommitment) {
      const entry = contributionByCommitment.get(commitmentId);
      if (entry) {
        entry.ordersFunded = funded.size;
      }
    }

    const withdrawnByCommitment = new Map<string, Prisma.Decimal>();
    let totalWithdrawn = new Prisma.Decimal(0);
    for (const reduction of reductions) {
      withdrawnByCommitment.set(
        reduction.commitmentId,
        (withdrawnByCommitment.get(reduction.commitmentId) ?? new Prisma.Decimal(0)).add(
          reduction.usdtAmount,
        ),
      );
      totalWithdrawn = totalWithdrawn.add(reduction.usdtAmount);
    }

    let totalCommitted = new Prisma.Decimal(0);
    let totalDistributed = new Prisma.Decimal(0);
    let totalRemaining = new Prisma.Decimal(0);
    let activeRemaining = new Prisma.Decimal(0);
    let activeProviderCount = 0;
    for (const provider of providers) {
      const commitment = provider.commitment;
      if (commitment) {
        totalCommitted = totalCommitted.add(commitment.usdtCommitted);
        totalDistributed = totalDistributed.add(commitment.usdtConsumed);
        totalRemaining = totalRemaining.add(commitment.usdtAvailable);
        if (
          provider.status === LiquidityProviderStatus.ACTIVE &&
          commitment.status === LiquidityCommitmentStatus.ACTIVE
        ) {
          activeRemaining = activeRemaining.add(commitment.usdtAvailable);
        }
      }
      if (provider.status === LiquidityProviderStatus.ACTIVE) {
        activeProviderCount += 1;
      }
    }

    // Same strictly-below comparison the overview uses: exactly meeting the
    // threshold is met, not short - but computed without touching notices.
    const difference = threshold.sub(activeRemaining);
    const belowThreshold = difference.gt(0);
    const shortfall = difference.isNegative() ? new Prisma.Decimal(0) : difference;

    const share = (value: Prisma.Decimal, base: Prisma.Decimal): Prisma.Decimal =>
      base.isZero() ? new Prisma.Decimal(0) : value.div(base).mul(100).toDecimalPlaces(2);

    const rows: LiquidityProviderDistributionRow[] = providers.map((provider) => {
      const commitment = provider.commitment;
      const contribution = commitment
        ? (contributionByCommitment.get(commitment.commitmentId) ?? {
            contributedUsdt: new Prisma.Decimal(0),
            contributedInr: new Prisma.Decimal(0),
            allocationCount: 0,
            ordersFunded: 0,
            lastAllocatedAt: null,
          })
        : null;
      const wallet = walletByUser.get(provider.userId) ?? null;

      return {
        lpId: provider.lpId,
        userId: provider.userId,
        email: provider.user.email,
        status: provider.status,
        registeredAt: provider.registeredAt,
        commitment,
        contributedUsdt: contribution?.contributedUsdt ?? new Prisma.Decimal(0),
        contributedInr: contribution?.contributedInr ?? new Prisma.Decimal(0),
        allocationCount: contribution?.allocationCount ?? 0,
        ordersFunded: contribution?.ordersFunded ?? 0,
        lastAllocatedAt: contribution?.lastAllocatedAt ?? null,
        reducedUsdt: commitment
          ? (withdrawnByCommitment.get(commitment.commitmentId) ?? new Prisma.Decimal(0))
          : new Prisma.Decimal(0),
        shareOfCommittedPct: share(commitment?.usdtCommitted ?? new Prisma.Decimal(0), totalCommitted),
        shareOfAvailablePct: share(commitment?.usdtAvailable ?? new Prisma.Decimal(0), totalRemaining),
        wallet: wallet ? { available: wallet.available, locked: wallet.locked } : null,
      };
    });

    // Biggest contributor first; registration time breaks ties so the order
    // is deterministic (and matches the allocation walk for equal pledges).
    rows.sort((left, right) => {
      const byContribution = right.contributedUsdt.cmp(left.contributedUsdt);
      return byContribution !== 0
        ? byContribution
        : left.registeredAt.getTime() - right.registeredAt.getTime();
    });

    const recent = await this.prisma.liquidityAllocation.findMany({
      orderBy: [{ allocatedAt: 'desc' }, { allocationId: 'desc' }],
      take: 12,
      include: {
        order: { select: { side: true, usdtAmount: true } },
        commitment: {
          select: { lpId: true, lp: { select: { user: { select: { email: true } } } } },
        },
      },
    });

    return {
      totals: {
        totalCommittedUsdt: totalCommitted,
        totalDistributedUsdt: totalDistributed,
        totalRemainingUsdt: totalRemaining,
        totalWithdrawnUsdt: totalWithdrawn,
        distributedInr,
        allocationCount: slices.length,
        ordersFunded: fundedOrders.size,
        providerCount: providers.length,
        activeProviderCount,
        activeRemainingUsdt: activeRemaining,
        thresholdUsdt: threshold,
        shortfallUsdt: shortfall,
        belowThreshold,
        commitmentsEnabled,
      },
      providers: rows,
      recentAllocations: recent.map((slice) => ({
        allocationId: slice.allocationId,
        orderId: slice.orderId,
        orderSide: slice.order.side,
        orderUsdtAmount: slice.order.usdtAmount,
        commitmentId: slice.commitmentId,
        lpId: slice.commitment.lpId,
        providerEmail: slice.commitment.lp.user.email,
        usdtAmount: slice.usdtAmount,
        priceInr: slice.priceInr,
        inrAmount: slice.usdtAmount.mul(slice.priceInr),
        allocatedAt: slice.allocatedAt,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireSlabs() {
    const slabs = this.config.liquidity.emberSlabs;
    if (!slabsConfigured(slabs)) {
      throw DomainException.liquiditySlabsNotConfigured();
    }
    return slabs;
  }

  /** Reference data must be present and active before anything moves against it. */
  private async requireAsset(symbol: string): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { symbol } });

    if (!asset) {
      throw DomainException.notFound('Asset', symbol);
    }
    if (!asset.isActive) {
      throw DomainException.assetInactive(asset.symbol);
    }

    return asset;
  }

  /**
   * Serialises operations on one logical key for the duration of the caller's
   * transaction - the paper and copy modules' advisory-lock pattern.
   */
  private async lockLiquidityKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
  }
}
