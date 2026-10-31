import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { EmberStakingController } from './ember-staking.controller';
import { EmberStakingService } from './ember-staking.service';

/**
 * Simulated EMBER staking.
 *
 * Imports `WalletModule` because staking is real locking (LOCK/UNLOCK ledger
 * legs move actual balances through the only ledger writer) and
 * `AppConfigModule` for the APR and lock period. Rewards are read-time
 * figures; nothing in this module ever mints or credits them.
 */
@Module({
  imports: [AppConfigModule, WalletModule],
  controllers: [EmberStakingController],
  providers: [EmberStakingService],
  exports: [EmberStakingService],
})
export class EmberStakingModule {}
