import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { ExchangeRevenueService } from './exchange-revenue.service';

/**
 * MODULE 08 x MODULE 11 — the pass that works the exchange revenue queue.
 *
 * Same shape as `CopyWorkerService`, for the same reasons: it is a schedule and
 * nothing else. Durability lives in `exchange_revenue_events`, which survives a
 * restart, a crash and a redeploy, and in the deterministic idempotency keys
 * that make a replayed pipeline land on the records it already made. All this
 * class adds is a clock, and every behaviour it has can be had on demand
 * through `POST /tokenomics/exchange-revenue/run-once`.
 *
 * NO OVERLAPPING PASSES. A burn can wait a minute for a chain receipt, so a
 * fifteen-second tick would otherwise stack passes on the same queue. The
 * in-process flag keeps one worker per process; the guarded claim in
 * `ExchangeRevenueService` is what keeps two *processes* honest, because a flag
 * cannot reach across a network.
 */
@Injectable()
export class ExchangeRevenueWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExchangeRevenueWorkerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private passRunning = false;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly exchangeRevenue: ExchangeRevenueService,
  ) {
    this.enabled = config.tokenomics.exchangeRevenueWorkerEnabled;
    this.intervalMs = config.tokenomics.exchangeRevenueWorkerIntervalMs;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(
        'Exchange revenue worker is disabled; settled orders are processed only through POST /tokenomics/exchange-revenue/run-once.',
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    // Never hold the process open just to fire an empty pass.
    this.timer.unref();

    this.logger.log(`Exchange revenue worker started, one pass every ${this.intervalMs}ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass over the queue. Safe to call directly, and the tests do. */
  async runOnce(): Promise<number> {
    if (this.passRunning) return 0;

    this.passRunning = true;
    try {
      const claimed = await this.exchangeRevenue.runPass();
      if (claimed > 0) {
        this.logger.log(`Exchange revenue worker processed ${claimed} settled order(s).`);
      }
      return claimed;
    } catch (error: unknown) {
      // The queue read failed. Nothing moved, so the rows still say PENDING and
      // the next pass picks up exactly where this one stopped.
      this.logger.error(
        `Exchange revenue pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.passRunning = false;
    }
  }
}
