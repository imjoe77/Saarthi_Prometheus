import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { TreasuryController } from './treasury.controller';
import { TreasuryReserveGuard } from './treasury-reserve.guard';
import { TreasuryService } from './treasury.service';

/**
 * MODULE 12 - treasury guardrails and dashboard reads.
 *
 * Imports `WalletModule` for the exported `WalletService` and reads treasury
 * balances through its public `getBalances`, the same posture every other
 * Module 03 consumer uses - this module never writes `wallet_balances` or
 * `transactions`. `AppConfigModule` carries the approved demo monthly
 * capacity (INR) and the display-only USDT/INR rate used to convert it.
 *
 * EXPORTS `TreasuryReserveGuard` for Module 11: the strict atomic reserve
 * check must run inside the burn's own transaction (with an advisory lock
 * against concurrent burns), so the guard travels to the only module that
 * debits the treasury. Module 11 imports this module solely for that
 * provider - there is no import cycle, because nothing here depends on
 * Module 11.
 *
 * Deliberately NOT here: any credit/mint route (funding stays test/seed
 * only), any wallet-status transition (enforcement is the in-transaction
 * check, never a status lever), and any supply calculation (Module 10 owns
 * supply; Module 11 owns its records and the per-caller views).
 */
@Module({
  imports: [AppConfigModule, WalletModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, TreasuryReserveGuard],
  exports: [TreasuryReserveGuard],
})
export class TreasuryModule {}
