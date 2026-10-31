import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

/**
 * MODULE 04 - the derived portfolio read model.
 *
 * This is the first module to depend on another feature module, and it does so
 * through the one mechanism Module 03 built for exactly this case:
 * `WalletModule` exports `WalletService`, its narrow read/mutate API. Portfolio
 * imports that service rather than reading `wallet_balances` itself, which keeps
 * a single place that knows how a user's balances are found.
 *
 * The dependency is one-way. `WalletModule` does not know Portfolio exists, so
 * there is no import cycle and the accounting boundary has not been widened.
 *
 * `PortfolioService` is exported for the same reason `WalletService` is: a later
 * module that must read a user's position (Strategy, Copy Trading, the Trading
 * Buddy) should consume this read model instead of re-deriving one.
 */
@Module({
  imports: [WalletModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}