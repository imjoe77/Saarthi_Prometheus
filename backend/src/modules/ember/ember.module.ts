import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { EmberController } from './ember.controller';
import { EmberService } from './ember.service';

/**
 * MODULE 10 — EMBER token accounting.
 *
 * Imports `WalletModule` for the same reason Module 08 does: a transfer moves
 * real Module 03 balances as one atomic unit through `WalletService` rather
 * than writing `wallet_balances` or `transactions` directly. The dependency
 * is the exported `WalletService` and nothing else - this module has no
 * direct access to the ledger tables, and it adds no second accounting
 * system: `ember_transfers` is an idempotency and audit row, never a balance.
 *
 * Deliberately NOT here: staking, APY, rewards, minting, burning, and any
 * public lock/unlock endpoint. Locking remains Module 09's internal
 * WalletService path; this module respects those locks (debits cannot spend
 * locked value) and reports them (supply's lockedSupply includes LP locks)
 * without modifying Module 09 at all.
 */
@Module({
  imports: [WalletModule],
  controllers: [EmberController],
  providers: [EmberService],
})
export class EmberModule {}
