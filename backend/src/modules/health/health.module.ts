import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health feature module.
 *
 * Depends only on `DatabaseModule` (for the connectivity probe) and the global
 * config module. `PrismaService` is exported by a `@Global()` module so it does
 * not need re-importing here.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}