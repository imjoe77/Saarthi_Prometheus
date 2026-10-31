import { randomUUID } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, TransactionType, type EmberPurchase } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { parseEmberAmount } from '../tokenomics/domain/allocation-math';

const TREASURY_USER_EMAIL = 'treasury@prometheus.local';

/** Display-only purchase scenarios, shown with live computed costs. */
const SCENARIO_TEMPLATES: { label: string; emberAmount: string }[] = [
  { label: 'First taste', emberAmount: '250' },
  { label: 'Portfolio starter', emberAmount: '2500' },
  { label: 'Serious allocation', emberAmount: '25000' },
];

export interface EmberHubStatement {
  baselinePriceInr: string;
  dailyEmberLimit: string | null;
  monthlyEmberLimit: string | null;
  usdtRateInr: string | null;
  treasuryAvailableEmber: string | null;
  note: string;
}

export interface HubScenario {
  label: string;
  emberAmount: string;
  totalInr: string;
  totalUsdt: string | null;
}

@Injectable()
export class EmberHubService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  async statement(): Promise<EmberHubStatement> {
    return {
      baselinePriceInr: this.config.emberHub.baselinePriceInr,
      dailyEmberLimit: this.config.emberHub.dailyEmberLimit,
      monthlyEmberLimit: this.config.emberHub.monthlyEmberLimit,
      usdtRateInr: this.config.usdtPricing.fallbackPriceInr,
      treasuryAvailableEmber: await this.treasuryAvailableEmber(),
      note:
        'Prices and limits are configured values, not market observations. Purchases are internal transfers: treasury EMBER moves to the user and the user pays USDT that moves to the treasury. On-chain supply does not change.',
    };
  }

  async scenarios(): Promise<{ note: string; scenarios: HubScenario[] }> {
    const price = this.config.emberHub.baselinePriceInr;
    const rate = this.config.usdtPricing.fallbackPriceInr;
    const scenarios = SCENARIO_TEMPLATES.map((template) => {
      const totalInr = new Prisma.Decimal(template.emberAmount).times(price);
      return {
        label: template.label,
        emberAmount: template.emberAmount,
        totalInr: totalInr.toFixed(2),
        totalUsdt: rate ? this.usdtAmount(totalInr, rate) : null,
      };
    });
    return {
      note:
        'Everything here is display-only simulation at the configured price and rate: no purchase is computed, recorded or executed.',
      scenarios,
    };
  }

  /**
   * Commits a purchase in one transaction: the EMBER treasury transfer out,
   * the user's EMBER transfer in, the user's USDT debit and the treasury's
   * USDT credit move together with the purchase row, or nothing moves.
   */
  async purchase(
    userId: string,
    dto: { emberAmount: string; clientRequestId: string; note?: string },
  ): Promise<{ purchase: EmberPurchase; created: boolean }> {
    const amount = parseEmberAmount(dto.emberAmount);
    const rate = this.config.usdtPricing.fallbackPriceInr;

    // No configured rate means the USDT payment legs cannot be priced. The
    // hub refuses rather than inventing a rate (or worse, skipping payment).
    if (rate === null) {
      throw new DomainException(
        ERROR_CODES.PRICING_UNAVAILABLE,
        'The USDT/INR display rate is not configured, so a purchase cannot be priced. Nothing was charged and no EMBER moved. Set USDT_FALLBACK_PRICE_INR and retry.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const [replay, userWallet, emberAsset, usdtAsset] = await Promise.all([
      this.prisma.emberPurchase.findUnique({
        where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
      }),
      this.walletService.getOrCreateForUser(userId),
      this.prisma.asset.findUnique({ where: { symbol: 'EMBER' } }),
      this.prisma.asset.findUnique({ where: { symbol: 'USDT' } }),
    ]);
    if (replay) {
      if (replay.status === 'FAILED') {
        throw DomainException.conflict(
          `clientRequestId was already used for a purchase that failed: ${replay.failedReason ?? 'the attempt did not complete'}. Reuse one idempotency key per unique request.`,
        );
      }
      return { purchase: replay, created: false };
    }
    if (!emberAsset || !usdtAsset) {
      throw DomainException.notFound('Asset');
    }
    await this.assertWithinPeriodLimits(amount, userId);

    const price = new Prisma.Decimal(this.config.emberHub.baselinePriceInr);
    const totalInr = price.times(amount);
    const totalUsdt = new Prisma.Decimal(this.usdtAmount(totalInr, rate));

    const treasury = await this.treasuryWallet();

    try {
      const purchase = await this.prisma.$transaction(async (tx) => {
        await this.walletService.debit(
          treasury.walletId,
          emberAsset.id,
          amount,
          { type: TransactionType.TRANSFER_OUT, note: `Hub purchase legs to user ${userId}${dto.note ? `: ${dto.note}` : ''}` },
          tx,
        );
        await this.walletService.credit(
          userWallet.wallet.id,
          emberAsset.id,
          amount,
          { type: TransactionType.TRANSFER_IN, note: `Hub purchase from treasury${dto.note ? `: ${dto.note}` : ''}` },
          tx,
        );
        await this.walletService.debit(
          userWallet.wallet.id,
          usdtAsset.id,
          totalUsdt,
          { type: TransactionType.TRANSFER_OUT, note: `Hub purchase payment of ${amount.toFixed(18)} EMBER${dto.note ? `: ${dto.note}` : ''}` },
          tx,
        );
        await this.walletService.credit(
          treasury.walletId,
          usdtAsset.id,
          totalUsdt,
          { type: TransactionType.TRANSFER_IN, note: `Hub purchase payment for ${amount.toFixed(18)} EMBER${dto.note ? `: ${dto.note}` : ''}` },
          tx,
        );
        return tx.emberPurchase.create({
          data: {
            userId,
            emberAmount: amount,
            emberPriceInr: price,
            totalInr,
            usdtRateInr: rate,
            totalUsdt,
            status: 'COMPLETED',
            clientRequestId: dto.clientRequestId,
          },
        });
      });
      return { purchase, created: true };
    } catch (error) {
      if (error instanceof DomainException) throw error;

      // A non-domain failure rolls the whole transaction back; the audit row
      // is written outside of it so the attempt is visible and reproducible.
      const reason = error instanceof Error ? error.message.slice(0, 250) : 'the purchase did not complete';
      await this.prisma.emberPurchase
        .createMany({
          data: {
            purchaseId: randomUUID(),
            userId,
            emberAmount: amount,
            emberPriceInr: price,
            totalInr,
            usdtRateInr: rate,
            totalUsdt,
            status: 'FAILED',
            clientRequestId: dto.clientRequestId,
            failedReason: reason,
            failedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async purchasesFor(userId: string, limit = 50): Promise<EmberPurchase[]> {
    return this.prisma.emberPurchase.findMany({
      where: { userId },
      orderBy: { purchasedAt: 'desc' },
      take: limit,
    });
  }

  async purchases(limit = 100): Promise<EmberPurchase[]> {
    return this.prisma.emberPurchase.findMany({
      orderBy: { purchasedAt: 'desc' },
      take: limit,
    });
  }

  /** The USDT/INR display rate is optional; the hub refuses rather than inventing one. */
  private usdtAmount(totalInr: Prisma.Decimal, rateInr: string): string {
    return totalInr.div(new Prisma.Decimal(rateInr)).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toFixed(6);
  }

  private async assertWithinPeriodLimits(amount: Prisma.Decimal, userId: string): Promise<void> {
    const limits = this.config.emberHub;
    const now = new Date();
    if (limits.dailyEmberLimit !== null) {
      const window = this.utcWindow(now, 'day');
      await this.assertWindowLimit(userId, window, amount, new Prisma.Decimal(limits.dailyEmberLimit), 'daily');
    }
    if (limits.monthlyEmberLimit !== null) {
      const window = this.utcWindow(now, 'month');
      await this.assertWindowLimit(userId, window, amount, new Prisma.Decimal(limits.monthlyEmberLimit), 'monthly');
    }
  }

  private async assertWindowLimit(
    userId: string,
    window: { start: Date; end: Date },
    requested: Prisma.Decimal,
    limit: Prisma.Decimal,
    label: string,
  ): Promise<void> {
    const aggregate = await this.prisma.emberPurchase.aggregate({
      _sum: { emberAmount: true },
      where: {
        userId,
        status: 'COMPLETED',
        purchasedAt: { gte: window.start, lt: window.end },
      },
    });
    const consumed = aggregate._sum.emberAmount ?? new Prisma.Decimal(0);
    if (consumed.plus(requested).greaterThan(limit)) {
      throw DomainException.conflict(
        `This purchase would exceed the ${label} EMBER limit (limit ${limit.toFixed()}, already purchased this ${label === 'daily' ? 'day' : 'month'}: ${consumed.toFixed(18)}).`,
        [`${label}_limit:${limit.toFixed()}`, `consumed:${consumed.toFixed(18)}`],
      );
    }
  }

  private utcWindow(reference: Date, unit: 'day' | 'month'): { start: Date; end: Date } {
    if (unit === 'day') {
      const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
      const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + 1));
      return { start, end };
    }
    const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
    const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1));
    return { start, end };
  }

  private async treasuryAvailableEmber(): Promise<string | null> {
    const treasury = await this.treasuryWalletReference();
    if (!treasury) return null;
    const ember = await this.prisma.asset.findUnique({ where: { symbol: 'EMBER' }, select: { id: true } });
    if (!ember) return null;
    const row = await this.prisma.walletBalance.findUnique({
      where: { walletId_assetId: { walletId: treasury.id, assetId: ember.id } },
      select: { available: true },
    });
    return row?.available.toFixed(18) ?? null;
  }

  private async treasuryWallet(): Promise<{ walletId: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: TREASURY_USER_EMAIL },
      select: { id: true, wallet: { select: { id: true } } },
    });
    if (!user) {
      throw DomainException.conflict(
        'The treasury wallet does not exist yet, so there is no inventory to buy from. Fund the treasury (a qualifying seed or demo deposit) first.',
      );
    }
    let walletId = user.wallet?.id;
    if (!walletId) {
      walletId = (await this.walletService.getOrCreateForUser(user.id)).wallet.id;
    }
    return { walletId };
  }

  private async treasuryWalletReference(): Promise<{ id: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: TREASURY_USER_EMAIL },
      select: { id: true, wallet: { select: { id: true } } },
    });
    if (!user) return null;
    if (user.wallet) return { id: user.wallet.id };
    const created = await this.walletService.getOrCreateForUser(user.id);
    return { id: created.wallet.id };
  }
}
