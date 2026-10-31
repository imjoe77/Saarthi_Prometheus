import { SetMetadata } from '@nestjs/common';

import type { Role } from '@prisma/client';

/** Metadata key the roles guard reads. */
export const ROLES_KEY = 'prometheus:roles';

/**
 * Restricts a handler to callers holding at least one of the listed roles.
 *
 *   @Post()
 *   @Roles(Role.EXPERT_TRADER, Role.PLATFORM_ADMIN)
 *   create(...) {}
 *
 * Applied on top of the global AuthGuard, so the caller is already
 * authenticated; this decorator answers the separate question of authorization.
 * A handler without it is reachable by any authenticated user - the same
 * default the application had before RBAC, preserved so read endpoints stay
 * open to their existing callers.
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
