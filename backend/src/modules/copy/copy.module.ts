import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { LiveDataModule } from '../live-data/live-data.module';
import { PaperModule } from '../paper/paper.module';
import { StrategyModule } from '../strategy/strategy.module';
import { WalletModule } from '../wallet/wallet.module';
import { CopyController } from './copy.controller';
import { CopyExecutionService } from './copy-execution.service';
import { CopyExplainerService } from './copy-explainer.service';
import { CopyService } from './copy.service';
import { CopyWorkerService } from './copy-worker.service';

/**
 * MODULE 07 - the copy trading module.
 *
 * DEPENDENCIES, AND WHAT EACH ONE IS FOR.
 *  - `StrategyModule`: resolving visibility and ownership with the same
 *    `findVisibleTo` / `findOwned` calls Module 05 owns, so "may I follow this"
 *    and "may I read this" cannot drift apart.
 *  - `PaperModule`: the *port*, not the tables. This module reads committed
 *    fills through `PAPER_EXECUTION_PORT` and never names `paper_orders`, which
 *    is what keeps the follower's engine replaceable if 06c's ledger ever is.
 *  - `WalletModule`: the follower's real USDT balance, which gates whether a
 *    copy may happen at all.
 *  - `DatabaseModule`: Prisma, for this module's own four tables.
 *
 * `LiveDataModule` is imported for the READ side only: the engine itself never
 * prices a copy - the price policy is mirror-price, so a copy executes at the
 * expert's committed fill and needs no feed, no quote and no websocket. What
 * the feed is used for is marking the follower's open positions at the market
 * so the screen can say what they are worth.
 *
 * THE WORKER IS A PROVIDER, NOT A CRON. `CopyWorkerService` starts its interval
 * on application bootstrap (unless configuration disables it) and clears it on
 * destroy, so the same instance the sync route calls is the one the timer drives
 * - there is no second implementation of the loop to keep in step.
 */
@Module({
  imports: [DatabaseModule, StrategyModule, PaperModule, WalletModule, LiveDataModule],
  controllers: [CopyController],
  providers: [CopyService, CopyExecutionService, CopyWorkerService, CopyExplainerService],
  exports: [CopyService, CopyExecutionService, CopyWorkerService, CopyExplainerService],
})
export class CopyModule {}
