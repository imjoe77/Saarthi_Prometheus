import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { AdaptiveBurnPolicyService } from './adaptive-burn-policy.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { ExchangeRevenueService } from './exchange-revenue.service';
import { ExchangeRevenueWorkerService } from './exchange-revenue-worker.service';
import { TreasuryModule } from '../treasury/treasury.module';
import { WalletModule } from '../wallet/wallet.module';
import { TokenomicsController } from './tokenomics.controller';
import { TokenomicsService } from './tokenomics.service';

/**
 * MODULE 11 — EMBER tokenomics.
 *
 * Imports `AppConfigModule` for the configured split the service reads at
 * request time (boot-validated to sum to 100) and `WalletModule` for the same
 * reason Modules 08-10 do: burns debit EMBER entirely through `WalletService`
 * (as a BURN ledger leg) inside the caller's transaction - this module never
 * writes `wallet_balances` or `transactions` itself. Allocations and
 * simulated buybacks move nothing at all.
 *
 * Imports `TreasuryModule` (owner-approved minimal change) solely for the
 * exported `TreasuryReserveGuard`: the Module 12 reserve check must run
 * inside the burn's own transaction, under its advisory lock, so the
 * check and the debit commit or roll back together. No cycle: treasury does
 * not import this module.
 *
 * Supply figures are read from Module 10's endpoint rather than duplicated
 * here: this module produces burns, Module 10 reports them, and both
 * reconcile through the ledger.
 *
 * THE EXCHANGE BRIDGE (Module 08 x Module 11). `ExchangeRevenueService` turns
 * settled USDT orders into tokenomics records by CALLING `TokenomicsService`,
 * never by writing its tables. It lives here rather than in Module 08 so the
 * allocation/buyback/burn ownership stays in one place and `UsdtModule` needs
 * exactly one import to reach it. The worker is the queue's clock only; the
 * service is directly runnable without it, which is what the tests and the
 * manual run-once route use.
 *
 * `TokenomicsService` stays private to this module: the bridge is the only new
 * caller and it is right here. The HTTP surface is unchanged - every mutation
 * route still sits behind PLATFORM_ADMIN, and the bridge is an internal caller
 * with its own system user, not a way around RBAC.
 */
@Module({
  imports: [AppConfigModule, WalletModule, TreasuryModule, BlockchainModule],
  controllers: [TokenomicsController],
  providers: [
    TokenomicsService,
    AdaptiveBurnPolicyService,
    ExchangeRevenueService,
    ExchangeRevenueWorkerService,
  ],
  exports: [ExchangeRevenueService],
})
export class TokenomicsModule {}
