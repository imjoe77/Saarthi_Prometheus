import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthModule } from './modules/auth/auth.module';
import { BlockchainModule } from './modules/blockchain/blockchain.module';
import { CopyModule } from './modules/copy/copy.module';
import { EmberHubModule } from './modules/ember-hub/ember-hub.module';
import { EmberModule } from './modules/ember/ember.module';
import { EmberStakingModule } from './modules/ember-staking/ember-staking.module';
import { HealthModule } from './modules/health/health.module';
import { LiveDataModule } from './modules/live-data/live-data.module';
import { LiquidityModule } from './modules/liquidity/liquidity.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { PaperModule } from './modules/paper/paper.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { ProfileModule } from './modules/profile/profile.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { AiDoubtSolverModule } from './modules/ai-doubt-solver/ai-doubt-solver.module';
import { SentinelModule } from './modules/sentinel/sentinel.module';
import { RiskModule } from './modules/risk/risk.module';
import { SimulationModule } from './modules/simulation/simulation.module';
import { StrategyModule } from './modules/strategy/strategy.module';
import { TokenomicsModule } from './modules/tokenomics/tokenomics.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { UsdtModule } from './modules/usdt/usdt.module';
import { WalletModule } from './modules/wallet/wallet.module';

/**
 * Root composition module.
 *
 * MODULE 00 scope. Feature modules are registered here one at a time as later
 * modules are implemented and frozen - nothing is imported speculatively.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    AssetsModule,
    WalletModule,
    PortfolioModule,
    StrategyModule,
    MarketDataModule,
    LiveDataModule,
    SimulationModule,
    PaperModule,
    PlatformAdminModule,
    RiskModule,
    CopyModule,
    UsdtModule,
    LiquidityModule,
    EmberModule,
    TokenomicsModule,
    TreasuryModule,
    BlockchainModule,
    EmberHubModule,
    EmberStakingModule,
    RbacModule,
    ProfileModule,
    SentinelModule,
    AiDoubtSolverModule,
    PaymentsModule,
  ],
})
export class AppModule {}
