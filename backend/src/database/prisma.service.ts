import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../config/config.module';
import { withConnectionLimit } from './datasource-url';

/**
 * Prisma lifecycle wrapper.
 *
 * Why not inject `PrismaClient` directly?
 *  - Nest owns connection creation/teardown, so the pool is opened once at
 *    bootstrap and closed on shutdown rather than per request.
 *  - Pool sizing is read from validated config instead of environment reads
 *    scattered through the codebase.
 *  - A single seam for future concerns (soft-delete scoping, tenant filters,
 *    transaction helpers) without touching call sites.
 *
 * Startup policy: by default the service starts even when the database is
 * unreachable, because liveness must not depend on a dependency the process
 * can still usefully report on. `/health` then answers with the database marked
 * down, which is exactly the diagnostic an operator needs. Set
 * `DATABASE_FAIL_FAST=true` for environments that prefer a hard boot failure.
 *
 * NOTE: this module contains connectivity only. Query and schema work belongs
 * to later modules.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private connected = false;
  private readonly failFastOnConnect: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      datasources: {
        db: {
          url: withConnectionLimit(config.databaseUrl, config.databasePoolMax),
        },
      },
      log: ['warn', 'error'],
    });
    this.failFastOnConnect = config.databaseFailFast;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.connected = true;
      this.logger.log('Database connection established.');
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.connected = false;

      if (this.failFastOnConnect) {
        this.logger.error(`Database connection failed and DATABASE_FAIL_FAST is set: ${reason}`);
        throw error;
      }

      // The secret-bearing portion of a driver error is never returned to a
      // caller; only the summary is logged.
      this.logger.warn(
        `Database is not reachable at startup: ${reason}. The service will start and ` +
          'report the database as down via GET /health until the connection recovers.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.connected = false;
    this.logger.log('Database connection closed.');
  }

  /** Whether the last connect attempt succeeded. Diagnostics only. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Liveness probe for /health.
   *
   * Runs `SELECT 1` with a bounded timeout so a hung or unreachable database
   * surfaces as an unhealthy check quickly instead of holding the health
   * request open until the client's own timeout fires.
   *
   * @returns milliseconds spent on the round trip.
   * @throws the underlying driver error when the database is unreachable.
   */
  async ping(timeoutMs: number): Promise<number> {
    const startedAt = process.hrtime.bigint();
    await Promise.race([
      this.$queryRaw(Prisma.sql`SELECT 1`),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Database ping timed out after ${timeoutMs}ms`)), timeoutMs).unref();
      }),
    ]);
    const elapsedNs = process.hrtime.bigint() - startedAt;
    return Number(elapsedNs) / 1_000_000;
  }
}