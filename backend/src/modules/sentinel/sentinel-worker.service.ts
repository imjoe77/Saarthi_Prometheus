import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { SentinelMonitorService } from './sentinel-monitor.service';
import { SentinelCallerService } from './sentinel-caller.service';

/**
 * MODULE 14 - the scheduler that starts, stops and recovers both passes.
 *
 * ONE TIMER, TWO PASSES. The monitor evaluates the alert book; the caller
 * drains call jobs. They share a single interval deliberately: one process
 * heartbeat to reason about, and the passes' own re-entrancy guards (plus the
 * database's guarded updates) make their concurrency story independent of the
 * timer's shape.
 *
 * THE WORKER IS A PROVIDER, NOT A CRON, and it is the copy worker's twin: it
 * starts on application bootstrap when configuration enables it, clears its
 * timer on destroy, and under NODE_ENV=test it is off unless explicitly set,
 * because a background timer would make test results non-deterministic. The
 * synchronous run-once route is what suites drive instead.
 *
 * RECOVERY: nothing in a pass process is stateful across restarts. Queue
 * references, attempt budgets and retry schedules live in `sentinel_voice_calls`
 * rows; a pass after a redeploy simply finds the same pending rows and
 * continues them from the database, not from memory.
 */
@Injectable()
export class SentinelWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SentinelWorkerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly monitor: SentinelMonitorService,
    private readonly caller: SentinelCallerService,
  ) {
    this.enabled = config.sentinel.workerEnabled;
    this.intervalMs = config.sentinel.workerIntervalMs;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Sentinel worker is disabled; monitoring and calls run only through POST /sentinel/run-once.');
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Never hold the process open just to fire an empty pass.
    this.timer.unref();

    this.logger.log(`Sentinel worker started, one pass every ${this.intervalMs}ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.log('Sentinel worker stopped.');
    }
  }

  /** Both passes, each absorbing its own failures so neither can starve the other. */
  private async tick(): Promise<void> {
    const at = new Date();
    try {
      const monitorStats = await this.monitor.runOnce(at);
      if (monitorStats.triggered > 0) {
        this.logger.log(
          `Monitor pass: ${monitorStats.activeAlerts} active, ${monitorStats.triggered} triggered, ` +
            `${monitorStats.callsQueued} calls queued, ${monitorStats.quoteFailures} quote failures.`,
        );
      }
    } catch (error) {
      this.logger.error(`Monitor pass failed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }

    try {
      const callerStats = await this.caller.runOnce(at);
      if (callerStats.initiated > 0 || callerStats.failed > 0) {
        this.logger.log(
          `Caller pass: ${callerStats.initiated} initiated, ${callerStats.retried} retried, ${callerStats.failed} failed.`,
        );
      }
    } catch (error) {
      this.logger.error(`Caller pass failed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }
  }
}
