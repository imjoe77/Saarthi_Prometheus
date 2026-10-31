import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { DomainException } from '../src/common/errors/domain.exception';
import { APP_CONFIG, type AppConfig } from '../src/config/config.module';
import { PrismaService } from '../src/database/prisma.service';
import { slabsConfigured } from '../src/modules/liquidity/domain/ember-slabs';
import { LiquidityService } from '../src/modules/liquidity/liquidity.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import type { BalanceWithAsset } from '../src/modules/wallet/wallet.types';

/**
 * `npm run seed:liquidity` entry point - the DEMO liquidity-provider seed.
 *
 * SIMULATED FUNDS ONLY: every USDT and EMBER figure credited below is demo
 * data for the prototype, not real money, and the notes on those ledger rows
 * say so. Three demo LPs are topped up to their target balances; providers and
 * commitments are registered only when approved EMBER slabs are configured
 * (`LIQUIDITY_EMBER_SLABS`), because commitments the service cannot gate are
 * refused with 503 and this script will not invent a locking rule.
 *
 * IDEMPOTENT by construction: balances are topped up only to their targets
 * (never double-credited), an LP that already has a commitment is left alone,
 * and no `liquidity_providers` row is created unless its commitment is created
 * in the same run - so a run with no slabs keeps BUY orders on Module 08's
 * legacy behaviour rather than silently switching enforcement on with zero
 * usable liquidity.
 *
 * Exit code is the contract: any LP that could not be fully seeded prints its
 * finding and the process exits 1, because a half-seeded demo pool that looked
 * successful is exactly what the next person will not suspect.
 */

/** Demo LPs: email, target USDT/EMBER balances, and the USDT to commit. */
const DEMO_LPS = [
  { email: 'lp1@prometheus.demo', usdt: '150000', ember: '50000', commitUsdt: '150000' },
  { email: 'lp2@prometheus.demo', usdt: '300000', ember: '100000', commitUsdt: '300000' },
  { email: 'lp3@prometheus.demo', usdt: '600000', ember: '150000', commitUsdt: '600000' },
] as const;

const SIMULATED_NOTE = 'SIMULATED LP seed funding (demo only - not real money)';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const config = app.get<AppConfig>(APP_CONFIG);
    const prisma = app.get(PrismaService);
    const walletService = app.get(WalletService);
    const liquidityService = app.get(LiquidityService);

    const commitmentsEnabled = slabsConfigured(config.liquidity.emberSlabs);
    let failures = 0;

    console.log('Module 09 demo liquidity seed (simulated funds only).');
    if (commitmentsEnabled) {
      console.log(
        `  EMBER slabs configured: ${config.liquidity.emberSlabs.length} - providers and commitments will be created.`,
      );
    } else {
      console.log('  EMBER slabs NOT configured (LIQUIDITY_EMBER_SLABS empty): crediting demo wallets only.');
      console.log('  No liquidity providers will be registered, so BUY orders keep legacy behaviour until');
      console.log('  approved slabs are set and this script is rerun.');
    }

    for (const demo of DEMO_LPS) {
      try {
        const user = await upsertDemoUser(prisma, demo.email);
        const { wallet } = await walletService.getOrCreateForUser(user.id);
        const balances = await walletService.getBalances(user.id);

        await topUp(prisma, walletService, balances, wallet.id, 'USDT', demo.usdt);
        await topUp(prisma, walletService, balances, wallet.id, 'EMBER', demo.ember);

        if (!commitmentsEnabled) {
          console.log(
            `  ${demo.email}: wallets funded (USDT ${demo.usdt}, EMBER ${demo.ember}); commitments skipped - no slabs.`,
          );
          continue;
        }

        const existing = await liquidityService.getMyCommitment(user.id);
        if (existing.commitment) {
          console.log(
            `  ${demo.email}: commitment already present (${existing.commitment.usdtCommitted.toFixed(6)} USDT, status ${existing.commitment.status}); left unchanged.`,
          );
          continue;
        }

        const { commitment, created } = await liquidityService.createCommitment(user.id, {
          usdtAmount: demo.commitUsdt,
          clientRequestId: randomUUID(),
        });
        console.log(
          `  ${demo.email}: ${created ? 'created' : 'updated'} commitment ${commitment.commitmentId} - ` +
            `${commitment.usdtCommitted.toFixed(6)} USDT pledged, EMBER locked ${commitment.emberLocked.toFixed(6)}.`,
        );
      } catch (error) {
        failures += 1;
        reportFailure(demo.email, error);
      }
    }

    if (failures > 0) {
      console.error(`\n${failures} demo LP(s) could not be fully seeded - see findings above.`);
      process.exitCode = 1;
    } else {
      console.log('\nDemo liquidity seed complete (simulated funds only).');
    }
  } finally {
    await app.close();
  }
}

async function upsertDemoUser(prisma: PrismaService, email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;

  console.log(`  creating demo LP user ${email} (standalone seed row, no sign-in identity).`);
  return prisma.user.create({ data: { email } });
}

/**
 * Tops a balance up to - never beyond - its target, which is what makes the
 * script safe to rerun: a second run credits nothing.
 */
async function topUp(
  prisma: PrismaService,
  walletService: WalletService,
  balances: BalanceWithAsset[],
  walletId: string,
  symbol: 'USDT' | 'EMBER',
  target: string,
): Promise<void> {
  const asset = await prisma.asset.findUnique({ where: { symbol } });
  if (!asset) {
    throw DomainException.notFound('Asset', symbol);
  }

  const balance = balances.find((row) => row.asset.symbol === symbol);
  const current = balance ? balance.available : new Prisma.Decimal(0);
  const shortfall = new Prisma.Decimal(target).sub(current);

  if (shortfall.lte(0)) {
    return;
  }

  await walletService.credit(walletId, asset.id, shortfall, { note: SIMULATED_NOTE });
}

function reportFailure(email: string, error: unknown): void {
  if (error instanceof DomainException) {
    console.error(`  ${email}: ${error.code} - ${error.message}`);
    return;
  }
  console.error(`  ${email}: unexpected error -`, error);
}

main().catch((error: unknown) => {
  console.error('Fatal error during liquidity seed:', error);
  process.exit(1);
});
