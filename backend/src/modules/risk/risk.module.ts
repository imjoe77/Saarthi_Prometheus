import { Module } from '@nestjs/common';

import { SimulationModule } from '../simulation/simulation.module';
import { PersistedDailyValueSeries } from '../simulation/persistence/persisted-daily-value-series';
import { EQUITY_SERIES_PORT } from './ports/equity-series.port';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { StrategyModule } from '../strategy/strategy.module';

/**
 * MODULE 06 - the Risk Engine.
 *
 * A small module with three dependencies and the third one is the whole story
 * of Module 06b. `StrategyModule` is imported for visibility resolution only -
 * the Risk Engine reads strategies, it does not create, update or archive them -
 * and `StrategyModule` exports `StrategyService` precisely so Modules 06 and 07
 * can resolve visibility without reaching for Prisma and reimplementing the rules.
 *
 * There is no cycle: Risk depends on Strategy and on Simulation, Strategy and
 * Simulation depend on nothing in this module, and the port implementation that
 * Simulation exports refers to Risk's *types* only, which are erased at runtime.
 *
 * THE PROVIDER IS THE WHOLE STORY OF THIS RELEASE. Before Module 06b,
 * `EmptyEquitySeries` returned no observations and every response was
 * `INSUFFICIENT_DATA / NO_HISTORY` - an honest report of absent evidence. The
 * approved Module 06b change is exactly the swap that port existed for: Simulated
 * history now exists, `SimulationModule` exports `PersistedDailyValueSeries`,
 * and `useExisting` binds it to the port token. Nothing else in this module
 * moves - the service, the controller, the domain functions and the response
 * shape were written for real data, and now measure it.
 *
 * `RiskService` is exported so a later module can ask for a reading directly -
 * a copy-trading screen showing what it is about to follow, say - without
 * going through HTTP.
 */
@Module({
  imports: [StrategyModule, SimulationModule],
  controllers: [RiskController],
  providers: [RiskService, { provide: EQUITY_SERIES_PORT, useExisting: PersistedDailyValueSeries }],
  exports: [RiskService],
})
export class RiskModule {}
