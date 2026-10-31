import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { buildValidationPipe } from './common/pipes/validation.pipe';
import { HEALTH_SERVICE_NAME, HEALTH_SERVICE_VERSION } from './modules/health/health.service';

/**
 * Builds a fully configured Nest application.
 *
 * Separated from `main.ts` so integration tests construct the exact same
 * application - a test that bootstraps its own app inevitably drifts from
 * production configuration and stops proving anything.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Payment-provider webhooks are signed over the exact bytes that were
    // sent, so the raw body has to survive parsing. Without this the webhook
    // route could only ever verify a re-serialised payload, and the signature
    // would never match.
    rawBody: true,
  });

  const config = app.get<AppConfig>(APP_CONFIG);

  app.setGlobalPrefix(config.normalisedPrefix);
  app.useGlobalPipes(buildValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor());

  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 600,
  });

  // Trust the first reverse proxy hop for protocol detection, without trusting
  // arbitrary X-Forwarded-* headers.
  app.set('trust proxy', 1);

  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    setupSwagger(app, config);
  }

  // Restore buffered logs now that the configured level is known.
  const nestLogLevel = config.nestLogLevel;
  app.useLogger(nestLogLevel ? [nestLogLevel] : false);

  return app;
}

function setupSwagger(app: NestExpressApplication, config: AppConfig): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Prometheus Backend API')
      .setDescription(
        'Prometheus digital-asset platform backend. Prototype scope: simulated accounting and ' +
          'execution only. No real custody, settlement, liquidity or brokerage.',
      )
      .setVersion(HEALTH_SERVICE_VERSION)
      .addServer(`/${config.normalisedPrefix}`, 'Default')
      .build(),
  );

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
    customSiteTitle: 'Prometheus API Docs',
  });
}

/** Starts the HTTP server. Not called during tests. */
export async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<AppConfig>(APP_CONFIG);

  await app.listen(config.port, config.host);

  const logger = new Logger('Bootstrap');
  const base = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  const prefix = config.normalisedPrefix ? `/${config.normalisedPrefix}` : '';

  logger.log(`${HEALTH_SERVICE_NAME} v${HEALTH_SERVICE_VERSION} started in ${config.nodeEnv}`);
  logger.log(`Health : ${base}${prefix}/health`);
  if (config.swaggerEnabled) {
    logger.log(`Docs   : ${base}/docs`);
  }
}