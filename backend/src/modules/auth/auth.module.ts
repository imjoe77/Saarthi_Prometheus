import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { APP_CONFIG, type AppConfig, AppConfigModule } from '../../config/config.module';
import { DatabaseModule } from '../../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { AccessTokenVerifier, AUTH_TOKEN_VERIFIER } from './token-verifier.service';

/**
 * Authentication and identity (MODULE 02).
 *
 * Owns exactly three things:
 *  1. Verifying that a request carries a token this service can cryptographically
 *     vouch for, and that the token is unexpired and intended for us.
 *  2. Mapping that verified external identity onto a Prometheus `User.id`.
 *  3. Exposing the resulting identity to controllers through `@CurrentUser()`.
 *
 * It deliberately does NOT authenticate against OAuth, hold OAuth client
 * credentials, or decide who may access which resource. OAuth happens entirely
 * in the Next.js app; authorization is per-resource and belongs to the module
 * that owns the resource.
 *
 * `AuthGuard` is bound with `APP_GUARD` here, which is why the application is
 * secure-by-default without a single `@UseGuards` in any controller.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: AUTH_TOKEN_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AccessTokenVerifier => new AccessTokenVerifier(config.auth),
    },
    // Registered as an application guard rather than per-controller, so a new
    // endpoint is protected by default. The single opt-out is `@Public()`.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AUTH_TOKEN_VERIFIER],
})
export class AuthModule {}