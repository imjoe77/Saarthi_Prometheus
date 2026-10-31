import { ValidationPipe } from '@nestjs/common';

/**
 * The single definition of DTO validation behaviour, shared by `main.ts` and
 * the tests so a test cannot accidentally validate differently from production.
 *
 * `forbidNonWhitelisted` makes unexpected properties an explicit 400 rather than
 * a silently ignored typo - important when a client sends `ammount` instead of
 * `amount` and would otherwise get a confusing partial success.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    validateCustomDecorators: true,
  });
}