import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TransactionType } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import {
  resolveBurnSplit,
  type BurnPolicyDecision,
  type TreasuryHealthReading,
} from './domain/burn-policy';

/**
 * The treasury-health-driven split provider for Module 11.
 *
 * Reads the same basis the reserve guard protects: treasury EMBER available
 * over cumulative COMPLETED DEPOSIT funding. The pure arithmetic lives in
 * `domain/burn-policy.ts`; this class only exists because the health reading
 * needs the database. `resolveSplit` answers with concrete percentages the
 * allocation and preview paths snap into their records, and never throws for
 * an absent treasury - no funding history yet simply means the baseline.
 */
@Injectable()
export class AdaptiveBurnPolicyService {
  private static readonly TREASURY_EMAIL = 'treasury@prometheus.local';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async resolveSplit(): Promise<BurnPolicyDecision> {
    const health = await this.readTreasuryHealth();
    return resolveBurnSplit(
      {
        baselineDirectBurnPct: this.config.tokenomics.directBurnPct,
        adaptiveSplit: this.config.tokenomics.adaptiveSplit,
        upperHealthPct: this.config.tokenomics.adaptiveUpperHealthPct,
        lowerHealthPct: this.config.tokenomics.adaptiveLowerHealthPct,
        minDirectBurnPct: this.config.tokenomics.adaptiveMinBurnPct,
      },
      health,
    );
  }

  private async readTreasuryHealth(): Promise<TreasuryHealthReading | null> {
    const ember = await this.prisma.asset.findUnique({ where: { symbol: 'EMBER' }, select: { id: true } });
    if (!ember) return null;
    const user = await this.prisma.user.findUnique({
      where: { email: AdaptiveBurnPolicyService.TREASURY_EMAIL },
      select: { id: true },
    });
    if (!user) return null;
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!wallet) return null;
    const [balance, funding] = await Promise.all([
      this.prisma.walletBalance.findUnique({
        where: { walletId_assetId: { walletId: wallet.id, assetId: ember.id } },
        select: { available: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          walletId: wallet.id,
          assetId: ember.id,
          type: TransactionType.DEPOSIT,
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      }),
    ]);
    return {
      treasuryAvailableEmber: balance?.available ?? new Prisma.Decimal(0),
      qualifyingFundingEmber: funding._sum.amount ?? new Prisma.Decimal(0),
    };
  }
}
