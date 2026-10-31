import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfig, createAppConfig } from './app.config';
import { validateEnvironment } from './env.validation';

export { AppConfig, AuthConfig, createAppConfig, resolvePem } from './app.config';
export { envValidationSchema, validateEnvironment, formatEnvValidationError } from './env.validation';

/** Injection token for the validated, typed {@link AppConfig} instance. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Global configuration module.
 *
 * `validate` runs Joi over the merged environment. On failure `validateEnvironment`
 * throws, which aborts bootstrap before the HTTP server binds. That is the
 * intended behaviour: fail loudly at start rather than serve requests from a
 * half-configured process.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      validate: validateEnvironment,
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => createAppConfig(process.env),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}