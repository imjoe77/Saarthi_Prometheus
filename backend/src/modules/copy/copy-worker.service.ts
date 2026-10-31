import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PAPER_EXECUTION_PORT, type PaperExecutionPort } from '../paper/ports/paper-execution.port';
import { CopyExecutionService } from './copy-execution.service';
import { CopyService } from './copy.service';

/** Fills read from the port in one page. */
const PAGE_SIZE = 100;

/** Hard ceiling of pages per follow per pass, so a pathological backlog cannot
 *  turn one tick into an unbounded hold on the timer. The remainder is picked up
 *  by the next pass, because the cursor moves as far as the work went. */
const MAX_PAGES_PER_FOLLOW = 50;

/**
 * MODULE 07 - the background pass that turns committed expert fills into copy
 * events.
 *
 * IT IS A POLL, NOT A QUEUE. There is no Redis and no message broker in this
 * project, and adding one would not make the engine more durable than it
 * already is: durability lives in `strategy_follows.cursor_*`, which survives a
 * restart, a crash and a redeploy, and in the primary key of `copy_events`,
 * which makes a replayed fill a no-op. All the worker adds is a schedule.
 *
 * ORDERING IS THE PORT'S CONTRACT, ENFORCED HERE BY COPYING IT. Fills are read
 * ascending by `(filledAt, orderId)` and applied one at a time. A follow's
 * events therefore land in the expert's own order regardless of how the passes
 * interleave with other follows, and a page that ends mid-backlog resumes from
 * the last fill this pass actually consumed - not from where it meant to.
 *
 * FAILURES ARE PER FOLLOW, NEVER PER PASS. One follow that cannot write (a
 * closed transaction, a missing row) stops that follow and leaves its cursor
 * behind, so the fill is retried on the next pass; the other follows in the
 * same queue still run. A rejection is not a failure: it is a committed outcome
 * written by `CopyExecutionService`, and it advances the cursor like any other.
 *
 * NO OVERLAPPING PASSES. `runOnce` is re-entrant-guarded, because a slow pass
 * on a short interval would otherwise have two workers reading the same page at
 * once. They would not corrupt anything - the advisory lock and the primary key
 * both absorb that - but they would do it twice for no gain.
 */
@Injectable()
export class CopyWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyWorkerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private passRunning = false;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly copyService: CopyService,
    private readonly copyExecution: CopyExecutionService,
    @Inject(PAPER_EXECUTION_PORT) private readonly port: PaperExecutionPort,
  ) {
    this.enabled = config.copyTrading.workerEnabled;
    this.intervalMs = config.copyTrading.workerIntervalMs;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Copy worker is disabled; fills are consumed only through POST /copy/follows/:strategyId/sync.');
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    // Never hold the process open just to fire an empty pass.
    this.timer.unref();

    this.logger.log(`Copy worker started, one pass every ${this.intervalMs}ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass over every follow, in a stable order, returning how many fills
   * were consumed. Safe to call directly - the tests do, instead of waiting for
   * a timer they cannot predict.
   */
  async runOnce(): Promise<number> {
    if (this.passRunning) {
      return 0;
    }

    this.passRunning = true;
    try {
      const queue = await this.copyService.listFollowQueue();
      let consumed = 0;

      for (const row of queue) {
        consumed += await this.consumeFrom(
          row.followerId,
          row.strategyId,
          row.cursorFilledAt,
          row.cursorOrderId,
        );
      }

      if (consumed > 0) {
        this.logger.log(`Copy worker consumed ${consumed} fill(s) across ${queue.length} follow(s).`);
      }

      return consumed;
    } catch (error) {
      // The pass itself failed (queue read, port read). Nothing was applied
      // outside a transaction, so the cursors still point at the unfinished
      // work and the next pass resumes from there.
      this.logger.error(`Copy worker pass failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.passRunning = false;
    }
  }

  /**
   * Consumes everything the port will give up after `cursor` for ONE follow,
   * until a short page. This is the whole engine loop: the synchronous sync
   * route and the background pass are the same code with a different caller.
   *
   * Returns the number of events written (copied or refused), so a caller can
   * report progress rather than merely "done".
   */
  async consumeFrom(
    followerId: string,
    strategyId: string,
    startFilledAt: Date | null,
    startOrderId: string | null,
  ): Promise<number> {
    let cursorFilledAt = startFilledAt;
    let cursorOrderId = startOrderId;
    let consumed = 0;

    for (let page = 0; page < MAX_PAGES_PER_FOLLOW; page += 1) {
      const fills = await this.port.fillsAfter(strategyId, cursorFilledAt, cursorOrderId, PAGE_SIZE);
      if (fills.length === 0) {
        break;
      }

      for (const fill of fills) {
        try {
          const applied = await this.copyExecution.applyFill(followerId, strategyId, fill);
          // Only an event this call *wrote* counts as consumed. A fill the
          // engine had already recorded - delivered twice by a restart, a
          // cursor rewind or a racing pass - is real work skipped, not work
          // done, and reporting it as progress would be a false success.
          if (applied.created) {
            consumed += 1;
          }
        } catch (error) {
          // An infrastructure failure, not a refusal: the transaction rolled
          // back, so the stored cursor never moved past this fill. Stop this
          // follow (retrying it in this same loop would fail the same way) and
          // carry on with the next follow in the queue.
          this.logger.error(
            `Copy of fill ${fill.orderId} for ${followerId}/${strategyId} failed and will be retried: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          return consumed;
        }
      }

      const last = fills[fills.length - 1];
      if (last === undefined) {
        break;
      }
      cursorFilledAt = last.filledAt;
      cursorOrderId = last.orderId;

      if (fills.length < PAGE_SIZE) {
        break;
      }
    }

    return consumed;
  }

  /**
   * The synchronous route: consume one follow's backlog now, from the cursor
   * that follow is parked at. The cursor is read first, then every fill is
   * applied under the advisory lock, so a pass that races this call simply
   * delivers the same fills twice and the primary key makes the second
   * delivery a no-op.
   */
  async syncFollow(followerId: string, strategyId: string): Promise<{ consumed: number }> {
    const cursor = await this.copyService.getCursor(followerId, strategyId);
    const consumed = await this.consumeFrom(
      followerId,
      strategyId,
      cursor.cursorFilledAt,
      cursor.cursorOrderId,
    );
    return { consumed };
  }

  /** Whether the expert has committed a fill this follow has not consumed yet. */
  async hasPendingEvents(followerId: string, strategyId: string): Promise<boolean> {
    const cursor = await this.copyService.getCursor(followerId, strategyId);
    const pending = await this.port.fillsAfter(
      strategyId,
      cursor.cursorFilledAt,
      cursor.cursorOrderId,
      1,
    );
    return pending.length > 0;
  }
}
