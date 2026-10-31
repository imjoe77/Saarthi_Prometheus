import { Injectable } from '@nestjs/common';
import {
  AssetKind,
  Prisma,
  Role,
  TransactionStatus,
  TransactionType,
  UserStatus,
  WalletStatus,
} from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { normaliseAmount } from '../wallet/decimal.util';
import { WalletService } from '../wallet/wallet.service';

/** The platform treasury system account (shared convention across modules). */
const TREASURY_EMAIL = 'treasury@prometheus.local';

/**
 * How movement results are reported back to the admin API.
 */
export interface MovementResult {
  walletId: string;
  asset: { symbol: string; name: string; decimals: number };
  ledgerType: TransactionType;
  note: string;
  available: string;
  locked: string;
}

export interface StatusResult {
  userId: string;
  status: UserStatus;
}

export interface WalletStatusResult {
  walletId: string;
  walletStatus: WalletStatus;
}

export interface AssetStatusResult {
  symbol: string;
  name: string;
  kind: AssetKind;
  decimals: number;
  isActive: boolean;
}

export interface TreasuryBalanceView {
  symbol: string;
  decimals: number;
  available: string;
  locked: string;
}

/** Platform-wide counters, exactly as the records hold them. Nothing is derived beyond counts. */
export interface PlatformOverview {
  users: { total: number; byStatus: Record<UserStatus, number> };
  wallets: { total: number; byStatus: Record<WalletStatus, number> };
  roles: { role: Role; count: number }[];
  roleRequests: { total: number; pending: number };
  activity: {
    strategies: { total: number; public: number };
    copyFollows: number;
  };
  assets: {
    symbol: string;
    name: string;
    kind: AssetKind;
    decimals: number;
    isActive: boolean;
    walletsHolding: number;
    totalAvailable: string;
    totalLocked: string;
  }[];
  treasury: {
    provisioned: boolean;
    userId: string | null;
    walletId: string | null;
    walletStatus: WalletStatus | null;
    balances: TreasuryBalanceView[];
  };
  recentAudit: {
    id: string;
    action: string;
    actorEmail: string;
    targetUserId: string | null;
    detail: unknown;
    createdAt: Date;
  }[];
}

/** Everything the platform knows about one account, in one read for the admin console. */
export interface PlatformUserDetail {
  user: { id: string; email: string; status: UserStatus; createdAt: Date };
  roles: Role[];
  counts: { strategies: number; follows: number; roleRequests: number };
  wallet:
    | null
    | {
        id: string;
        status: WalletStatus;
        createdAt: Date;
        balances: { symbol: string; name: string; decimals: number; available: string; locked: string }[];
        ledger: {
          id: string;
          type: TransactionType;
          status: TransactionStatus;
          amount: string;
          availableAfter: string | null;
          lockedAfter: string | null;
          note: string | null;
          createdAt: Date;
          asset: { symbol: string; decimals: number };
        }[];
      };
}

/**
 * PLATFORM ADMIN - the platform's money and account controls.
 *
 * This is the one module that may adjust balances by hand: capital
 * injections, EMBER inventory top-ups, corrections and debits. Every route it
 * backs is `@Roles(PLATFORM_ADMIN)` and every action writes an `AdminAuditLog`
 * row in the same transaction as the movement it produced, so the audit trail
 * can never disagree with the balances it describes.
 *
 * Design points:
 *  - Movements run through `WalletService` (the only writer of balances) with
 *    the `ADJUSTMENT` ledger type, whose non-blank-note rule is enforced again
 *    here at the boundary - an unexplained manual correction is a bug.
 *  - Amounts are validated with `normaliseAmount` at the asset's own scale, so
 *    an admin cannot credit a fraction of a paisa or invent precision beyond
 *    the ledger's.
 *  - Freezing a wallet blocks ALL movements through it (including these),
 *    which is the point: a frozen wallet's balances may only be read.
 *  - Suspending or closing a user is enforced by `Auth.resolveIdentity`
 *    immediately: existing tokens stop resolving, since that check runs on
 *    every authenticated request.
 */
@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Credits the treasury's system wallet with an asset. This is how capital
   * (INR/USDT) and EMBER inventory reach the platform of record.
   */
  async fundTreasury(
    actorUserId: string,
    dto: { assetSymbol: string; amount: string; note: string },
  ): Promise<MovementResult> {
    return this.moveTreasury(actorUserId, 'CREDIT', 'treasury.funding', dto);
  }

  /**
   * Debits the treasury's system wallet - the reverse of funding: removing
   * capital, retiring inventory, correcting an over-funding. Same atomic
   * audit-or-nothing convention, and an insufficient balance is refused.
   */
  async withdrawFromTreasury(
    actorUserId: string,
    dto: { assetSymbol: string; amount: string; note: string },
  ): Promise<MovementResult> {
    return this.moveTreasury(actorUserId, 'DEBIT', 'treasury.withdrawal', dto);
  }

  /** The shared treasury movement: one ADJUSTMENT leg plus one audit row, or nothing. */
  private async moveTreasury(
    actorUserId: string,
    kind: 'CREDIT' | 'DEBIT',
    action: string,
    dto: { assetSymbol: string; amount: string; note: string },
  ): Promise<MovementResult> {
    const note = this.requiredNote(dto.note);

    // The treasury system account is auto-provisioned the same way the
    // tokenomics module does it: the first movement that needs it creates it
    // (and its wallet), so an admin console top-up never dead-ends on a
    // missing seed row.
    const { userId: treasuryId } = await this.ensureTreasury();

    const asset = await this.loadAsset(dto.assetSymbol);
    const value = normaliseAmount(dto.amount.trim(), { symbol: asset.symbol, decimals: asset.decimals });
    const { wallet } = await this.walletService.getOrCreateForUser(treasuryId);

    const balance = await this.prisma.$transaction(async (tx) => {
      const moved = kind === 'CREDIT'
        ? await this.walletService.credit(wallet.id, asset.id, value, { type: TransactionType.ADJUSTMENT, note }, tx)
        : await this.walletService.debit(wallet.id, asset.id, value, { type: TransactionType.ADJUSTMENT, note }, tx);
      await tx.adminAuditLog.create({
        data: {
          actorUserId,
          action,
          targetUserId: treasuryId,
          detail: {
            kind,
            asset: asset.symbol,
            amount: value.toString(),
            note,
            treasuryWalletId: wallet.id,
          },
        },
      });
      return moved;
    });

    return this.present(wallet.id, asset, balance, note);
  }

  /**
   * The treasury system account, created on first use. Two racing creators
   * resolve to one account: the loser catches the unique violation and reads
   * the winner's row - the same resolution every idempotent create in this
   * codebase uses.
   */
  private async ensureTreasury(): Promise<{ userId: string }> {
    const email = TREASURY_EMAIL;
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });

    if (existing) {
      return { userId: existing.id };
    }

    try {
      const created = await this.prisma.user.create({ data: { email } });
      return { userId: created.id };
    } catch (error) {
      if (!this.isUniqueConstraintViolation(error)) throw error;
      const winner = await this.prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      return { userId: winner.id };
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  /**
   * One manual CREDIT or DEBIT against a user's wallet. Both directions use
   * the same audit convention: the actor, the affected account, the amount,
   * the asset and the required reason are all on the audit row.
   */
  async moveWallet(
    actorUserId: string,
    targetUserId: string,
    dto: { kind: 'CREDIT' | 'DEBIT'; assetSymbol: string; amount: string; note: string },
  ): Promise<MovementResult> {
    const note = this.requiredNote(dto.note);

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      throw DomainException.notFound('User', targetUserId);
    }

    const asset = await this.loadAsset(dto.assetSymbol);
    const value = normaliseAmount(dto.amount.trim(), { symbol: asset.symbol, decimals: asset.decimals });
    const { wallet } = await this.walletService.getOrCreateForUser(target.id);

    const balance = await this.prisma.$transaction(async (tx) => {
      const moved = dto.kind === 'CREDIT'
        ? await this.walletService.credit(wallet.id, asset.id, value, { type: TransactionType.ADJUSTMENT, note }, tx)
        : await this.walletService.debit(wallet.id, asset.id, value, { type: TransactionType.ADJUSTMENT, note }, tx);

      await tx.adminAuditLog.create({
        data: {
          actorUserId,
          action: `wallet.${dto.kind.toLowerCase()}`,
          targetUserId: target.id,
          detail: {
            asset: asset.symbol,
            amount: value.toString(),
            note,
            walletId: wallet.id,
          },
        },
      });
      return moved;
    });

    return this.present(wallet.id, asset, balance, note);
  }

  /**
   * Sets a user's lifecycle status. SUSPENDED and CLOSED both stop the
   * account's tokens resolving immediately (`Auth.resolveIdentity` refuses
   * non-ACTIVE on every request) - one check, no grace period.
   */
  async setUserStatus(
    actorUserId: string,
    targetUserId: string,
    status: UserStatus,
  ): Promise<StatusResult> {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw DomainException.notFound('User', targetUserId);
    }
    if (user.status === status) {
      throw DomainException.conflict(`User is already ${status}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { status } });
      await tx.adminAuditLog.create({
        data: {
          actorUserId,
          action: 'user.status',
          targetUserId: user.id,
          detail: { from: user.status, to: status },
        },
      });
    });

    return { userId: user.id, status };
  }

  /**
   * Freezes or unfreezes the target's wallet. A frozen wallet refuses every
   * mutation (`loadActiveWallet`), so freezes are the way to hold an account
   * without touching its statuses or roles.
   */
  async setWalletStatus(
    actorUserId: string,
    targetUserId: string,
    status: WalletStatus,
  ): Promise<WalletStatusResult> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: targetUserId } });
    if (!wallet) {
      // Deliberately NOT created here: freezing a wallet-less account has no
      // meaning, and an accidental create would add a wallet nobody asked for.
      throw DomainException.notFound('Wallet for user', targetUserId);
    }
    if (wallet.status === status) {
      throw DomainException.conflict(`Wallet is already ${status}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { id: wallet.id }, data: { status } });
      await tx.adminAuditLog.create({
        data: {
          actorUserId,
          action: 'wallet.status',
          targetUserId,
          detail: { from: wallet.status, to: status },
        },
      });
    });

    return { walletId: wallet.id, walletStatus: status };
  }

  /**
   * The whole platform, one snapshot for the admin console: account and
   * wallet counters, role distribution, request queue depth, token activity,
   * per-asset aggregates across every wallet, the treasury's current state
   * and the latest audit rows. Read-only; counts come straight from the
   * records so the console can never display a number that disagrees with
   * the ledger.
   */
  async platformOverview(): Promise<PlatformOverview> {
    const [userTotal, userByStatus, walletTotal, walletByStatus, roleCounts, requestTotal, requestPending, assets, balanceAggregates, strategyTotal, publicStrategies, copyFollows, recentAudit, treasuryUser] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.wallet.count(),
        this.prisma.wallet.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.userRole.groupBy({ by: ['role'], _count: { _all: true } }),
        this.prisma.roleRequest.count(),
        this.prisma.roleRequest.count({ where: { status: 'PENDING' } }),
        this.prisma.asset.findMany({ orderBy: { symbol: 'asc' } }),
        this.prisma.walletBalance.groupBy({
          by: ['assetId'],
          _count: { _all: true },
          _sum: { available: true, locked: true },
        }),
        this.prisma.strategy.count(),
        this.prisma.strategy.count({ where: { visibility: 'PUBLIC' } }),
        this.prisma.strategyFollow.count(),
        this.prisma.adminAuditLog.findMany({
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { actor: { select: { email: true } } },
        }),
        this.prisma.user.findUnique({ where: { email: TREASURY_EMAIL } }),
      ]);

    const zeroBy = <Status extends string>(values: readonly Status[]) =>
      Object.fromEntries(values.map((status) => [status, 0])) as Record<Status, number>;
    const usersByStatus: Record<UserStatus, number> = zeroBy(Object.values(UserStatus));
    for (const row of userByStatus) {
      usersByStatus[row.status] = row._count._all;
    }
    const walletsByStatus: Record<WalletStatus, number> = zeroBy(Object.values(WalletStatus));
    for (const row of walletByStatus) {
      walletsByStatus[row.status] = row._count._all;
    }

    const aggregateByAsset = new Map(balanceAggregates.map((row) => [row.assetId, row]));
    const assetsView = assets.map((asset) => {
      const aggregate = aggregateByAsset.get(asset.id);
      return {
        symbol: asset.symbol,
        name: asset.name,
        kind: asset.kind,
        decimals: asset.decimals,
        isActive: asset.isActive,
        walletsHolding: aggregate?._count._all ?? 0,
        totalAvailable: (aggregate?._sum.available ?? new Prisma.Decimal(0)).toFixed(asset.decimals),
        totalLocked: (aggregate?._sum.locked ?? new Prisma.Decimal(0)).toFixed(asset.decimals),
      };
    });

    let treasuryView: PlatformOverview['treasury'] = {
      provisioned: false,
      userId: null,
      walletId: null,
      walletStatus: null,
      balances: [],
    };
    if (treasuryUser) {
      const wallet = await this.prisma.wallet.findUnique({ where: { userId: treasuryUser.id } });
      const balances = wallet
        ? await this.prisma.walletBalance.findMany({ where: { walletId: wallet.id }, include: { asset: true }, orderBy: { asset: { symbol: 'asc' } } })
        : [];
      treasuryView = {
        provisioned: true,
        userId: treasuryUser.id,
        walletId: wallet?.id ?? null,
        walletStatus: wallet?.status ?? null,
        balances: balances.map((balance) => ({
          symbol: balance.asset.symbol,
          decimals: balance.asset.decimals,
          available: balance.available.toFixed(balance.asset.decimals),
          locked: balance.locked.toFixed(balance.asset.decimals),
        })),
      };
    }

    return {
      users: { total: userTotal, byStatus: usersByStatus },
      wallets: { total: walletTotal, byStatus: walletsByStatus },
      roles: roleCounts
        .map((row) => ({ role: row.role, count: row._count._all }))
        .sort((a, b) => a.role.localeCompare(b.role)),
      roleRequests: { total: requestTotal, pending: requestPending },
      activity: {
        strategies: { total: strategyTotal, public: publicStrategies },
        copyFollows,
      },
      assets: assetsView,
      treasury: treasuryView,
      recentAudit: recentAudit.map((row) => ({
        id: row.id,
        action: row.action,
        actorEmail: row.actor.email,
        targetUserId: row.targetUserId,
        detail: row.detail,
        createdAt: row.createdAt,
      })),
    };
  }

  /**
   * One account, everything the platform knows about it: identity, roles,
   * activity counts, and - when the account holds one - the wallet with its
   * balances and the newest ledger legs. Read-only; a wallet-less account
   * returns `wallet: null` rather than silently creating one.
   */
  async userDetail(targetUserId: string): Promise<PlatformUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw DomainException.notFound('User', targetUserId);
    }

    const [roles, strategyCount, followCount, roleRequestCount, wallet] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId: user.id },
        select: { role: true },
        orderBy: { role: 'asc' },
      }),
      this.prisma.strategy.count({ where: { ownerId: user.id } }),
      this.prisma.strategyFollow.count({ where: { followerId: user.id } }),
      this.prisma.roleRequest.count({ where: { userId: user.id } }),
      this.prisma.wallet.findUnique({ where: { userId: user.id } }),
    ]);

    if (!wallet) {
      return {
        user: { id: user.id, email: user.email, status: user.status, createdAt: user.createdAt },
        roles: roles.map((row) => row.role),
        counts: { strategies: strategyCount, follows: followCount, roleRequests: roleRequestCount },
        wallet: null,
      };
    }

    const [balances, ledger] = await Promise.all([
      this.prisma.walletBalance.findMany({
        where: { walletId: wallet.id },
        include: { asset: true },
        orderBy: { asset: { symbol: 'asc' } },
      }),
      this.prisma.transaction.findMany({
        where: { walletId: wallet.id },
        include: { asset: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
    ]);

    return {
      user: { id: user.id, email: user.email, status: user.status, createdAt: user.createdAt },
      roles: roles.map((row) => row.role),
      counts: { strategies: strategyCount, follows: followCount, roleRequests: roleRequestCount },
      wallet: {
        id: wallet.id,
        status: wallet.status,
        createdAt: wallet.createdAt,
        balances: balances.map((balance) => ({
          symbol: balance.asset.symbol,
          name: balance.asset.name,
          decimals: balance.asset.decimals,
          available: balance.available.toFixed(balance.asset.decimals),
          locked: balance.locked.toFixed(balance.asset.decimals),
        })),
        ledger: ledger.map((leg) => ({
          id: leg.id,
          type: leg.type,
          status: leg.status,
          amount: leg.amount.toFixed(leg.asset.decimals),
          availableAfter: leg.availableAfter ? leg.availableAfter.toFixed(leg.asset.decimals) : null,
          lockedAfter: leg.lockedAfter ? leg.lockedAfter.toFixed(leg.asset.decimals) : null,
          note: leg.note,
          createdAt: leg.createdAt,
          asset: { symbol: leg.asset.symbol, decimals: leg.asset.decimals },
        })),
      },
    };
  }

  /**
   * Retires an asset for new activity, or brings a retired one back. A
   * deactivated asset refuses every movement the wallet layer can produce,
   * while balances and history stay readable - the way to pause an asset
   * without erasing anything. The note is required and audited like every
   * other privileged action here.
   */
  async setAssetActive(
    actorUserId: string,
    symbolInput: string,
    dto: { isActive: boolean; note: string },
  ): Promise<AssetStatusResult> {
    const note = this.requiredNote(dto.note);

    const asset = await this.loadAsset(symbolInput);
    if (asset.isActive === dto.isActive) {
      throw DomainException.conflict(`Asset ${asset.symbol} is already ${asset.isActive ? 'active' : 'inactive'}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.asset.update({ where: { id: asset.id }, data: { isActive: dto.isActive } });
      await tx.adminAuditLog.create({
        data: {
          actorUserId,
          action: 'asset.status',
          detail: {
            asset: asset.symbol,
            from: asset.isActive,
            to: dto.isActive,
            note,
          },
        },
      });
    });

    return {
      symbol: asset.symbol,
      name: asset.name,
      kind: asset.kind,
      decimals: asset.decimals,
      isActive: dto.isActive,
    };
  }

  // ---------------------------------------------------------------------------

  private async loadAsset(symbolInput: string): Promise<{
    id: string;
    symbol: string;
    name: string;
    kind: AssetKind;
    decimals: number;
    isActive: boolean;
  }> {
    const symbol = symbolInput.trim().toUpperCase();
    const asset = await this.prisma.asset.findUnique({ where: { symbol } });
    if (!asset) {
      throw DomainException.notFound('Asset', symbol);
    }
    return asset;
  }

  /** The ADJUSTMENT ledger type refuses blank notes; so does this boundary. */
  private requiredNote(note: string): string {
    const trimmed = (note ?? '').trim();
    if (!trimmed) {
      throw DomainException.badRequest('A note is required for every admin balance change.');
    }
    return trimmed;
  }

  private present(
    walletId: string,
    asset: { symbol: string; name: string; decimals: number },
    balance: { available: Prisma.Decimal; locked: Prisma.Decimal },
    note: string,
  ): MovementResult {
    return {
      walletId,
      asset: { symbol: asset.symbol, name: asset.name, decimals: asset.decimals },
      ledgerType: TransactionType.ADJUSTMENT,
      note,
      available: balance.available.toFixed(asset.decimals),
      locked: balance.locked.toFixed(asset.decimals),
    };
  }
}
