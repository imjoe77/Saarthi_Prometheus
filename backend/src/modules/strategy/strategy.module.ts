import { Module } from '@nestjs/common';

import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';

/**
 * MODULE 05 - the strategy registry.
 *
 * This module imports nothing. That is the point, and it is worth stating
 * explicitly: Module 04 was the first module to depend on another feature module,
 * and Strategy is the counter-example. It needs no wallet balance, no portfolio
 * snapshot and no asset catalogue, so it declares no dependency on any of them and
 * reads nothing but the global `PrismaService`.
 *
 * `StrategyService` is exported for the same reason `WalletService` and
 * `PortfolioService` are: Modules 06 (risk) and 07 (copy trading) need to read a
 * strategy, and consuming one narrow service is preferable to each of them
 * querying `strategies` directly and inventing its own visibility rules.
 */
@Module({
  controllers: [StrategyController],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
