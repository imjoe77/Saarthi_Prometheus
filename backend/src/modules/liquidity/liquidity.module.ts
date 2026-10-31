import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { LiquidityAllocationService } from './liquidity-allocation.service';
import { LiquidityController } from './liquidity.controller';
import { LiquidityService } from './liquidity.service';

/**
 * MODULE 09 — simulated liquidity providers and BUY-order funding.
 *
 * Imports `WalletModule` for the same reason Module 08 does: commitments lock
 * and unlock EMBER, and allocation moves LP USDT/INR, entirely through
 * `WalletService` inside the caller's transaction - this module never writes
 * `wallet_balances` or `transactions` itself.
 *
 * Exports `LiquidityAllocationService` to `UsdtModule`, which calls it inside
 * the BUY transaction (`UsdtService.place`). There is deliberately no reverse
 * dependency: liquidity knows nothing about orders beyond the id and amounts
 * its caller passes in, so the two modules compose without a cycle.
 *
 * SELL orders never reach this module's allocation path.
 */
@Module({
  imports: [AppConfigModule, WalletModule],
  controllers: [LiquidityController],
  providers: [LiquidityService, LiquidityAllocationService],
  exports: [LiquidityService, LiquidityAllocationService],
})
export class LiquidityModule {}
