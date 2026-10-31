import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { EmberHubController } from './ember-hub.controller';
import { EmberHubService } from './ember-hub.service';

/**
 * EMBER Hub (Module 13+): the configured distribution storefront.
 *
 * Imports `WalletModule` and `AppConfigModule` for the same reasons Module
 * 11 does: purchases move EMBER and USDT entirely through `WalletService`
 * legs inside the caller's transaction, priced and bounded by configuration.
 * No blockchain import: a purchase is an internal transfer and must never
 * touch the token contract.
 */
@Module({
  imports: [AppConfigModule, WalletModule],
  controllers: [EmberHubController],
  providers: [EmberHubService],
  exports: [EmberHubService],
})
export class EmberHubModule {}
