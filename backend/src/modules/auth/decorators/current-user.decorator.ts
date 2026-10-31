import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthContext } from '../auth.service';

/**
 * Injects the authenticated Prometheus user.
 *
 *   @Get()
 *   @UseGuards(AuthGuard)
 *   me(@CurrentUser() user: AuthContext) { ... }
 *
 * The value is the internal Prometheus `User.id`, resolved server-side from a
 * verified token. It is never read from the request: there is deliberately no
 * way for a caller to name a different user here, and no endpoint in the
 * application accepts a user id as input.
 *
 * Type is `AuthContext` rather than `string` so that using it without
 * narrowing (and forgetting to check `status`) is visible in review.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<{ user?: AuthContext }>();
    return request.user as AuthContext;
  },
);