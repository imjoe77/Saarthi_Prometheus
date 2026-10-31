import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Provides the single shared PrismaClient.
 *
 * `Global` so no feature module has to re-import it; importing PrismaService in
 * ten modules is exactly the kind of incidental coupling that makes later
 * extraction into a separate service painful.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}