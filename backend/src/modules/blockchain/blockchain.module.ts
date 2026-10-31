import { Module } from '@nestjs/common';

import { AppConfigModule, APP_CONFIG } from '../../config/config.module';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { EMBER_GATEWAY, createEmberGatewayFromConfig } from './gateway.provider';

/**
 * The on-chain counterpart of the EMBER economy.
 *
 * The gateway is built once from the configured deployment when the layer is
 * enabled (null otherwise, which makes every chain call fail fast with 503 -
 * a disabled layer is a deployment decision, not per-call breakage).
 *
 * The service is the single writer for mint requests, on-chain burn
 * propagation and event ingestion; reconciliation is its read comparison.
 * Nothing here is a background worker: event sync and recovery are explicit,
 * authorized routes.
 */
@Module({
  imports: [AppConfigModule],
  controllers: [BlockchainController],
  providers: [
    {
      provide: EMBER_GATEWAY,
      useFactory: createEmberGatewayFromConfig,
      inject: [APP_CONFIG],
    },
    BlockchainService,
  ],
  exports: [BlockchainService],
})
export class BlockchainModule {}
