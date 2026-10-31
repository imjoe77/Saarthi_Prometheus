import { Module } from '@nestjs/common';

import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * MODULE 03 — the accounting boundary.
 *
 * `WalletService` is exported so future feature modules (transfers, copy
 * trading, settlement) can move funds through it instead of writing the ledger
 * tables. Importing this module grants the ability to move money; that is
 * intentional and is the reason it is exported as one small, well-guarded API
 * rather than the tables being reachable directly.
 *
 * Depends only on the global `PrismaService`; it does not import `AssetsModule`.
 */
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
