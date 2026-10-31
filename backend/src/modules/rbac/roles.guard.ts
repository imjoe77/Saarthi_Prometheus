import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { AuthenticatedRequest } from '../auth/guards/auth.guard';
import { ROLES_KEY } from './roles.decorator';

/**
 * The single authorization gate for the whole API.
 *
 * Registered globally after the AuthGuard, so by the time this runs the
 * caller is an authenticated Prometheus user whose roles were resolved
 * server-side from the database. The decision is computed, in order:
 *
 *   1. Does this handler declare required roles? If not, any authenticated
 *      caller may reach it - the application's pre-RBAC default, preserved.
 *   2. Does the caller hold at least one required role?
 *
 * Nothing consults the request body, the query string, a header, or any
 * client-supplied role claim: roles come from `request.user`, which the
 * AuthGuard attached from the database.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const roles = request.user?.roles ?? [];

    if (!required.some((role) => roles.includes(role))) {
      // One message for every missing role. Naming the required role would
      // tell a caller which part of the surface is privileged; they already
      // know what they tried to call.
      throw new DomainException(
        ERROR_CODES.FORBIDDEN,
        'Your account does not have permission to perform this action.',
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
