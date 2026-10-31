import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Request } from 'express';

import { ERROR_CODES } from '../../../common/constants/error-codes';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { DomainException } from '../../../common/errors/domain.exception';
import { AuthService, type AuthContext } from '../auth.service';
import {
  AUTH_TOKEN_VERIFIER,
  InvalidAccessTokenError,
  type TokenVerifier,
} from '../token-verifier.service';

/** Authenticated caller, attached to the request for `@CurrentUser()`. */
export interface AuthenticatedRequest extends Request {
  user?: AuthContext;
}

/**
 * The single entry point to authentication for the whole API.
 *
 * Registered globally (Module 02), so a new controller is protected by default
 * and forgetting `@UseGuards` is impossible. Opting out is explicit and
 * greppable via `@Public()`.
 *
 * The guard answers one question - "is this request a request from a specific
 * Prometheus user?" - and answers it by computing, in order:
 *
 *   1. Is this route public? Then stop; nothing else applies.
 *   2. Is there a well-formed `Authorization: Bearer` header?
 *   3. Does the token verify against our public key, unexpired, issued by us,
 *      intended for us?
 *   4. Which Prometheus user does that verified identity belong to, and may
 *      they act?
 *
 * Nothing in that chain consults the request body, the query string, or any
 * client-supplied identifier.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);

    if (!token) {
      // No header, wrong scheme, or an empty value. The caller is told only
      // that authentication is required.
      throw new DomainException(
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication is required.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    let identity;
    try {
      identity = await this.verifier.verify(token);
    } catch (error) {
      // The reason code goes to the log, never to the client: "expired" versus
      // "bad signature" versus "wrong audience" is free reconnaissance.
      const reason = error instanceof InvalidAccessTokenError ? error.reason : 'unknown';
      this.logger.warn(`Rejected access token. reason=${reason}`);

      throw new DomainException(
        ERROR_CODES.UNAUTHENTICATED,
        'The access token is invalid or has expired.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // From here on the caller is authenticated but not yet a Prometheus user.
    // Resolving the identity can still fail - SUSPENDED, CLOSED, or a
    // first-login conflict - and those failures propagate as DomainExceptions
    // with their own status codes.
    request.user = await this.authService.resolveIdentity(identity);

    return true;
  }
}

/**
 * Pulls the token out of an `Authorization: Bearer <token>` header.
 *
 * Written by hand rather than pulled from a library because the accepted shape
 * is small and the failure modes matter: a header sent with no scheme, with the
 * wrong scheme, or with several spaces is rejected rather than guessed at. The
 * token is never logged or echoed, including when it fails.
 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers?.authorization;

  if (typeof header !== 'string') {
    return null;
  }

  const parts = header.split(' ');

  if (parts.length !== 2) {
    return null;
  }

  const [scheme, value] = parts;

  // Case-insensitive per RFC 7235, where the scheme is a token, not a string
  // match.
  if (!scheme || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = value?.trim() ?? '';

  return token.length > 0 ? token : null;
}