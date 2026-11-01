import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { LiveDataModule } from '../live-data/live-data.module';
import { StrategyModule } from '../strategy/strategy.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaperExecutionService } from './execution.service';
import { PAPER_EXECUTION_PORT } from './ports/paper-execution.port';
import { PaperExecutionStore } from './paper-execution.store';
import { PaperController } from './paper.controller';
import { PaperService } from './paper.service';

/**
 * MODULE 06c - the paper trading module.
 *
 * DEPENDENCIES. Imports `StrategyModule` (to resolve ownership via `findOwned`),
 * imports `LiveDataModule` (to read the catalogue and the latest quote atomically
 * and to access the fake provider in tests), imports `WalletModule` (to read the
 * trader's real USDT balance, which gates whether an order may be placed at all),
 * and the global `DatabaseModule`.
 * It exports nothing that would create cycles; `PaperExecutionPort` is exported
 * only for *implementations* that Module 07 will bind to via `useClass` of its
 * own choice, or Module 07 will implement it itself. The concrete store here is
 * injectable should a follower choose to `useExisting(PaperExecutionStore)`.
 */
@Module({
  imports: [DatabaseModule, StrategyModule, LiveDataModule, WalletModule],
  controllers: [PaperController],
  providers: [
    PaperService,
    PaperExecutionService,
    PaperExecutionStore,
    {
      provide: PAPER_EXECUTION_PORT,
      useClass: PaperExecutionStore,
    },
  ],
  exports: [PaperService, PAPER_EXECUTION_PORT, PaperExecutionStore],
})
export class PaperModule {}