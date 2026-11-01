import { Module } from '@nestjs/common';

import { APP_CONFIG, AppConfigModule, type AppConfig } from '../../config/config.module';
import { LiquidityModule } from '../liquidity/liquidity.module';
import { WalletModule } from '../wallet/wallet.module';
import { TokenomicsModule } from '../tokenomics/tokenomics.module';
import { FakeUsdtPricingProvider } from './providers/fake-usdt-pricing.provider';
import { LiveUsdtPricingProvider } from './providers/live-usdt-pricing.provider';
import {
  USDT_PRICING_PROVIDER,
  type UsdtPricingProvider,
} from './providers/usdt-pricing.types';
import { UsdtController } from './usdt.controller';
import { UsdtPricingService } from './usdt-pricing.service';
import { UsdtService } from './usdt.service';

/**
 * MODULE 08 — the USDT exchange.
 *
 * Imports `WalletModule` because an exchange order is the first flow in the
 * codebase that moves real wallet balances as one atomic unit: `UsdtService`
 * composes `WalletService.credit`/`debit` inside its own transaction rather
 * than writing `wallet_balances` or `transactions` itself. The dependency is
 * the exported `WalletService` and nothing else - this module has no direct
 * access to the ledger tables.
 *
 * The pricing provider is chosen from configuration, mirroring Module 06c:
 * `live` composes the public CoinDCX and CoinGecko endpoints, and `fake` is
 * the deterministic provider the automated suites run on (the default under
 * NODE_ENV=test, so no test ever needs network access or credentials).
 */
@Module({
  imports: [AppConfigModule, WalletModule, LiquidityModule, TokenomicsModule],
  controllers: [UsdtController],
  providers: [
    UsdtService,
    UsdtPricingService,
    LiveUsdtPricingProvider,
    FakeUsdtPricingProvider,
    {
      provide: USDT_PRICING_PROVIDER,
      inject: [LiveUsdtPricingProvider, FakeUsdtPricingProvider, APP_CONFIG],
      useFactory: (
        live: LiveUsdtPricingProvider,
        fake: FakeUsdtPricingProvider,
        config: AppConfig,
      ): UsdtPricingProvider => (config.usdtPricing.provider === 'fake' ? fake : live),
    },
  ],
})
export class UsdtModule {}
