import { Module } from '@nestjs/common';

import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';

/**
 * MODULE 06b - the historical market data catalogue.
 *
 * This module imports nothing, and that is the point. It reads the global
 * `PrismaService` and nothing else: candles are reference data, they belong to
 * no user, they have no wallet and no strategy, so there is no dependency for it
 * to declare. It is the leaf the simulation module hangs off.
 *
 * `MarketDataService` is exported for the same reason `StrategyService` is -
 * a later module that needs to know whether a symbol has data should consume
 * this service rather than query `market_candles` and reinvent what "has data"
 * means - but nothing consumes it yet, so the export exists only to keep the
 * module's boundary honest when it is first needed.
 */
@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
