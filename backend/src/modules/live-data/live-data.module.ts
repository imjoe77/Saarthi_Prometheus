import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { LiveDataController } from './live-data.controller';
import { LiveDataService } from './live-data.service';
import { AlpacaMarketDataProvider } from './providers/alpaca-market-data-provider';
import { FakeMarketDataProvider } from './providers/fake-market-data-provider';
import { MARKET_DATA_PROVIDER } from './providers/market-data-provider.port';
import { OffMarketDataProvider } from './providers/off-market-data-provider';

/**
 * MODULE 06c - the live market data module.
 *
 * WIRING BY CONFIG, NOT BY IF AT IMPORT TIME. The provider token is bound to the
 * concrete implementation chosen from `APP_CONFIG.marketData.provider`. The
 * default is `off` - every test and every first-run gets a feed that does
 * nothing and answers honestly about its absence. `fake` exposes its test
 * surface (seed/clear) through `FakeMarketDataProvider` instances injected by
 * the Nest module, so an e2e test can `app.get(FakeMarketDataProvider)` to stage
 * the exact market shape a case needs. `alpaca` is only selected when the
 * environment explicitly asks for it.
 *
 * `LiveDataService` is exported for the paper module to read the catalogue and
 * the latest quote atomically; controllers and other modules need no knowledge
 * of which backend is behind the token.
 */
@Module({
  providers: [
    LiveDataService,
    OffMarketDataProvider,
    FakeMarketDataProvider,
    AlpacaMarketDataProvider,
    {
      provide: MARKET_DATA_PROVIDER,
      inject: [OffMarketDataProvider, FakeMarketDataProvider, AlpacaMarketDataProvider, APP_CONFIG],
      useFactory: (
        off: OffMarketDataProvider,
        fake: FakeMarketDataProvider,
        alpaca: AlpacaMarketDataProvider,
        config: AppConfig,
      ) => {
        const provider = config.marketData.provider;
        if (provider === 'fake') return fake;
        if (provider === 'alpaca') return alpaca;
        return off;
      },
    },
  ],
  controllers: [LiveDataController],
  exports: [LiveDataService, FakeMarketDataProvider, MARKET_DATA_PROVIDER],
})
export class LiveDataModule {}
