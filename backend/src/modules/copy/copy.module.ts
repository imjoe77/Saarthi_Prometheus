import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { PaperModule } from '../paper/paper.module';
import { StrategyModule } from '../strategy/strategy.module';
import { CopyController } from './copy.controller';
import { CopyExecutionService } from './copy-execution.service';
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
 *  - `DatabaseModule`: Prisma, for this module's own four tables.
 *
 * NOT IMPORTED: `LiveDataModule`. The price policy is mirror-price - a copy
 * executes at the expert's committed fill - so the engine needs no feed, no
 * quote and no websocket. That is a deliberate reduction of moving parts: a
 * follower's fill that depends on a live quote can fail for reasons that have
 * nothing to do with the trade being copied.
 *
 * THE WORKER IS A PROVIDER, NOT A CRON. `CopyWorkerService` starts its interval
 * on application bootstrap (unless configuration disables it) and clears it on
 * destroy, so the same instance the sync route calls is the one the timer drives
 * - there is no second implementation of the loop to keep in step.
 */
@Module({
  imports: [DatabaseModule, StrategyModule, PaperModule],
  controllers: [CopyController],
  providers: [CopyService, CopyExecutionService, CopyWorkerService],
  exports: [CopyService, CopyExecutionService, CopyWorkerService],
})
export class CopyModule {}
