import { Module } from '@nestjs/common';

import { StrategyModule } from '../strategy/strategy.module';
import { PersistedDailyValueSeries } from './persistence/persisted-daily-value-series';
import { SimulationController } from './simulation.controller';
import { SimulationService } from './simulation.service';

/**
 * MODULE 06b - the deterministic simulation module.
 *
 * TWO DEPENDENCIES, NEITHER OF THEM SURPRISING. `StrategyModule` provides the
 * visibility rule every read goes through - a simulation is evidence about a
 * strategy, so who may see the evidence is decided by the strategy's own
 * service, not by reimplementing its rules here. `PrismaService` is global. The
 * candle window comes from `market_candles` through `simulation-store`, read
 * directly rather than through `MarketDataModule` because there is no
 * cross-module API to add for a full-window internal read - the service API the
 * module exports is for asking questions, not for fetching a dataset the
 * simulation already knows the shape of.
 *
 * `PersistedDailyValueSeries` is exported because Module 06 resolves it as the
 * provider of `EQUITY_SERIES_PORT`: the token is Risk's, the implementation is
 * this module's, and the wiring lives where Nest can see it. No risk file
 * changes for the switch; that was the point of the port.
 */
@Module({
  imports: [StrategyModule],
  controllers: [SimulationController],
  providers: [SimulationService, PersistedDailyValueSeries],
  exports: [PersistedDailyValueSeries],
})
export class SimulationModule {}