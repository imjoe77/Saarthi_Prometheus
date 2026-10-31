import { Module } from '@nestjs/common';

import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

/**
 * MODULE 03 — the asset catalogue.
 *
 * Depends only on the global `PrismaService`. It is not imported by
 * `WalletModule`: each reads the `assets` table through the global client, which
 * keeps feature modules from depending on one another (see `app.module.ts`).
 */
@Module({
  controllers: [AssetsController],
  providers: [AssetsService],
})
export class AssetsModule {}
