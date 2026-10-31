import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { HealthCheckEntryDto, HealthStatusDto } from './dto/health-status.dto';

export const HEALTH_SERVICE_NAME = 'prometheus-backend';
export const HEALTH_SERVICE_VERSION = '0.1.0';

/**
 * Aggregates dependency state for the health endpoint.
 *
 * Design decisions worth stating:
 *  - Health is *reported*, not *enforced*. `/health` always answers 200 with a
 *    body describing state; a 503 here would make the endpoint useless for
 *    differentiating "app is broken" from "a dependency is down". Liveness and
 *    readiness are a separate concern (see README) once deployment exists.
 *  - Failure detail is only exposed when the caller asks for it. The
 *    unprivileged response says a dependency is down without leaking a
 *    hostname, credential or driver message.
 *  - Errors are swallowed here on purpose. A health probe must always produce a
 *    response; throwing would surface as a generic 500 from the exception
 *    filter and lose the very information the operator needs.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly bootedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(verbose = false): Promise<HealthStatusDto> {
    const checks: HealthCheckEntryDto[] = [await this.checkDatabase()];

    const degraded = checks.some((check) => check.status === 'down');

    const payload: HealthStatusDto = {
      status: degraded ? 'error' : 'ok',
      service: HEALTH_SERVICE_NAME,
      version: HEALTH_SERVICE_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.bootedAt) / 1000),
      checks: checks.map((check) => (verbose ? check : this.redact(check))),
      // The AI trade-buddy endpoint always has the built-in knowledge base, so
      // it is never "missing a provider"; `aiProvider` says which source would
      // actually answer a question with the current configuration.
      providerConfigured: true,
      aiProvider: this.config.aiModelUrl ? 'model' : 'knowledge-base',
    };

    if (verbose) {
      payload.environment = this.config.nodeEnv;
    }

    if (degraded) {
      const failed = checks.filter((c) => c.status === 'down').map((c) => c.name);
      this.logger.warn(`Health degraded; failing dependencies: ${failed.join(', ')}`);
    }

    return payload;
  }

  private async checkDatabase(): Promise<HealthCheckEntryDto> {
    try {
      const latencyMs = await this.prisma.ping(this.config.databaseConnectTimeoutMs);
      return { name: 'database', status: 'up', latencyMs: round(latencyMs) };
    } catch (error: unknown) {
      // Logged in full, reported as a short reason.
      const reason = error instanceof Error ? error.message : 'unknown database error';
      this.logger.error(`Database health check failed: ${reason}`);

      return {
        name: 'database',
        status: 'down',
        error: 'Database connectivity check failed.',
      };
    }
  }

  /** Strips diagnostic detail for unprivileged callers. */
  private redact(check: HealthCheckEntryDto): HealthCheckEntryDto {
    const redacted: HealthCheckEntryDto = {
      name: check.name,
      status: check.status,
    };
    if (check.latencyMs !== undefined) redacted.latencyMs = check.latencyMs;
    return redacted;
  }
}

/** Rounds sub-millisecond floats so responses are stable and diff-friendly. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}