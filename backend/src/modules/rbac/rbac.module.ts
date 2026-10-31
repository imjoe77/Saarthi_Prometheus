import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AdminController, RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RolesGuard } from './roles.guard';

/**
 * Role-based access control.
 *
 * `RolesGuard` is bound with `APP_GUARD` here, running *after* the global
 * AuthGuard (registered in AuthModule), so authentication always happens
 * first and this guard only answers "may this authenticated caller do this?".
 * A controller with no `@Roles()` is reachable by any authenticated user -
 * the application's pre-RBAC default, preserved so existing read endpoints
 * keep their callers.
 */
@Module({
  controllers: [RbacController, AdminController],
  providers: [
    RbacService,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [RbacService],
})
export class RbacModule {}
