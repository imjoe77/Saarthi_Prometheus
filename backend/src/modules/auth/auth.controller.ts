import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthContext } from './auth.service';

/**
 * Shape of the protected response.
 *
 * Note what is absent: no `authUserId`, no provider, no token, no session
 * cookie. A client needs to know which Prometheus user it is acting as, and
 * nothing else about the credential chain.
 */
export class CurrentUserDto {
  /** Internal Prometheus user UUID. This is the id every business API uses. */
  id!: string;

  email!: string;

  status!: string;

  /** Which OAuth provider the current session came through, for display only. */
  provider!: string;
}

/**
 * Authentication endpoints.
 *
 * No `@Public()` here. Every route in this controller requires a valid token,
 * which is the point: these endpoints report the caller's own identity, so an
 * unauthenticated caller must get a 401 rather than an answer.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  /**
   * The current Prometheus identity.
   *
   * This endpoint exists to prove the whole chain works end to end: a browser
   * holds no token, the Next.js server attaches a Bearer token it signed, this
   * service verifies that signature independently, resolves the external
   * identity to a Prometheus user, and returns that user's UUID.
   *
   * There is no `/auth/me?userId=` variant, and there never will be.
   */
  @Get('me')
  @ApiOperation({
    summary: 'Current Prometheus identity',
    description:
      'Returns the Prometheus user resolved from the verified access token. ' +
      'The identity comes from the token only: no request input can change it.',
  })
  @ApiOkResponse({ type: CurrentUserDto })
  @HttpCode(HttpStatus.OK)
  getCurrentUser(@CurrentUser() user: AuthContext): CurrentUserDto {
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      provider: user.provider,
    };
  }
}