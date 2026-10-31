import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TransactionType, type EmberStakePosition } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { parseEmberAmount } from '../tokenomics/domain/allocation-math';

export interface StakeSimulation {
  aprPercent: string;
  elapsedDays: number;
  simulatedReward: string;
}

/**
 * Simulated EMBER staking.
 *
 * The stake itself is REAL wallet value: locking moves the position's EMBER
 * from available into locked (a LOCK ledger leg) and unstaking unlocks it -
 * exactly once, guarded by the row's status. The REWARDS are a read-time
 * simulation only: amount x configured APR% x elapsed days / 365 is computed
 * whenever a position is displayed, never stored to a wallet, never minted
 * and never a change to any supply figure. The API labels the two worlds -
 * `amount`/`status` are what the ledger holds; `simulatedReward` is display.
 */
@Injectable()
export class EmberStakingService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * The configured program parameters, as the UI needs them.
   *
   * There is exactly one lock period and one APR - both deployment config - so
   * a page offering a choice of periods must be able to say which one is real.
   * Reading it here (rather than the UI hard-coding a schedule) keeps the
   * number next to the code that applies it.
   */
  programConfig(): { aprPercent: string; lockDays: number } {
    return {
      aprPercent: this.config.emberStaking.aprPercent,
      lockDays: this.config.emberStaking.lockDays,
    };
  }

  async stake(userId: string, dto: { emberAmount: string; clientRequestId: string }): Promise<{ position: EmberStakePosition; created: boolean }> {
    const amount = parseEmberAmount(dto.emberAmount);
    const [replay, ember, userWallet] = await Promise.all([
      this.prisma.emberStakePosition.findUnique({
        where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
      }),
      this.requireEmber(),
      this.walletService.getOrCreateForUser(userId),
    ]);
    if (replay) {
      return { position: replay, created: false };
    }

    const stakeId = randomUUID();
    const lockUntil = new Date(Date.now() + this.config.emberStaking.lockDays * 24 * 60 * 60 * 1000);

    const position = await this.prisma.$transaction(async (tx) => {
      // Legs first, then the record: a duplicate key loses the insert race
      // and rolls its lock back with it.
      await this.walletService.lock(
        userWallet.wallet.id,
        ember.id,
        amount,
        { note: `EMBER stake position ${stakeId}` },
        tx,
      );
      return tx.emberStakePosition.create({
        data: { stakeId, userId, amount, status: 'ACTIVE', lockUntil, clientRequestId: dto.clientRequestId },
      });
    });

    return { position, created: true };
  }

  /** Fulfils the lock and marks the position UNSTAKED. Idempotent by state. */
  async unstake(userId: string, stakeId: string): Promise<{ position: EmberStakePosition; created: boolean }> {
    const position = await this.prisma.emberStakePosition.findUnique({ where: { stakeId } });
    if (!position || position.userId !== userId) {
      throw DomainException.notFound('Stake position');
    }
    if (position.status === 'UNSTAKED') {
      return { position, created: false };
    }
    if (position.lockUntil.getTime() > Date.now()) {
      throw DomainException.conflict(
        `This position is locked until ${position.lockUntil.toISOString()}. Early unstaking is refused rather than penalized: unlock the position after its lock expires.`,
      );
    }

    const ember = await this.requireEmber();
    const { wallet } = await this.walletService.getOrCreateForUser(userId);
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.walletService.unlock(
        wallet.id,
        ember.id,
        position.amount,
        { note: `EMBER stake position ${stakeId} unlocked` },
        tx,
      );
      return tx.emberStakePosition.update({
        where: { stakeId, status: 'ACTIVE' },
        data: { status: 'UNSTAKED', unstakedAt: new Date() },
      });
    });

    return { position: updated, created: true };
  }

  async positionsFor(userId: string, limit = 50): Promise<(EmberStakePosition & { simulation: StakeSimulation })[]> {
    const rows = await this.prisma.emberStakePosition.findMany({
      where: { userId },
      orderBy: { stakedAt: 'desc' },
      take: limit,
    });
    return Promise.all(rows.map(async (row) => ({ ...row, simulation: await this.simulationFor(row) })));
  }

  async simulationFor(row: EmberStakePosition): Promise<StakeSimulation> {
    const end = row.status === 'UNSTAKED' && row.unstakedAt ? row.unstakedAt : new Date();
    const elapsedMs = Math.max(0, end.getTime() - row.stakedAt.getTime());
    const elapsedDaysDecimal = new Prisma.Decimal(elapsedMs).div(24 * 60 * 60 * 1000);
    const reward = new Prisma.Decimal(row.amount.toString())
      .times(new Prisma.Decimal(this.config.emberStaking.aprPercent))
      .div(100)
      .times(elapsedDaysDecimal)
      .div(365)
      .toDecimalPlaces(18, Prisma.Decimal.ROUND_DOWN);
    return {
      aprPercent: this.config.emberStaking.aprPercent,
      elapsedDays: elapsedDaysDecimal.times(1e6).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).div(1e6).toNumber(),
      simulatedReward: reward.toFixed(18),
    };
  }

  private async requireEmber() {
    const ember = await this.prisma.asset.findUnique({ where: { symbol: 'EMBER' } });
    if (!ember) {
      throw DomainException.notFound('Asset', 'EMBER');
    }
    if (!ember.isActive) {
      throw DomainException.assetInactive(ember.symbol);
    }
    return ember;
  }
}
