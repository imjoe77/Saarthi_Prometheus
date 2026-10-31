import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminService } from './platform-admin.service';

/**
 * PLATFORM ADMIN - money and account controls.
 *
 * Imports `WalletModule` (which exports `WalletService`, the single writer of
 * balances) so every adjustment, correction and funding credit moves through
 * the guarded accounting boundary with the `ADJUSTMENT` ledger type instead of
 * touching `wallet_balances` directly. `PrismaService` is global. The
 * controller carries `@Roles(PLATFORM_ADMIN)` on the class; the global
 * RolesGuard backstops it.
 */
@Module({
  imports: [WalletModule],
  controllers: [PlatformAdminController],
  providers: [PlatformAdminService],
})
export class PlatformAdminModule {}
