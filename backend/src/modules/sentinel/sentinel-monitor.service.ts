import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type SentinelAlert, type SentinelVoiceCall } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { evaluateThreshold } from './domain/threshold';
import { composeVoiceAlertMessage } from './domain/voice-message';
import { LiveDataService } from '../live-data/live-data.service';
import type { QuoteDto } from '../live-data/dto/quote.dto';
import { SentinelVoiceService, type SentinelCallGateReason } from './sentinel-voice.service';

/**
 * MODULE 14 - the monitor pass: one sweep over the alert book.
 *
 * A PASS IS ONE QUOTE PER SYMBOL, NOT ONE QUOTE PER ALERT. Active alerts are
 * grouped by symbol and the group's evaluation shares one `LiveDataService`
 * quote, so eight instruments never become two hundred quote requests no
 * matter how many alerts point at them. The pass is a poll with a guard
 * (`running`) the way Module 07's pass is, so a slow sweep and a fast interval
 * cannot overlap.
 *
 * THE TRIGGER IS ONE GUARDED UPDATE + ONE CALL ROW, IN ONE TRANSACTION. The
 * update's WHERE restates `status = ACTIVE`, so between two workers that read
 * the same active alert only one can claim the transition; the loser's
 * `updateMany` matches zero rows, and its job is over. The call row rides in
 * the same transaction, and its unique `(alert_id)` is the physical vow that
 * one alert can never queue two calls. Nothing here trusts an in-memory flag
 * that a second replica would not share.
 *
 * ABSENCE AND STALENESS NEVER TRIGGER. A quote that is missing, stale, or
 * from a closed session updates the alert's observation (so the UI can say
 * "market closed" or "stale quote") and records the monitoring state - but the
 * threshold is evaluated only on a fresh, available, in-session price. No
 * fabricated price, no stale price, no silent substitution.
 */
@Injectable()
export class SentinelMonitorService {
  private readonly logger = new Logger(SentinelMonitorService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly liveData: LiveDataService,
    private readonly voice: SentinelVoiceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Runs one monitoring pass. Returns what the pass did, for tests, the
   * run-once route and the status surface.
   */
  async runOnce(at: Date): Promise<SentinelMonitorPassStats> {
    if (this.running) {
      this.logger.debug('Monitor pass already running; skipping this tick.');
      return { activeAlerts: 0, evaluated: 0, triggered: 0, callsQueued: 0, gated: 0, expired: 0, quoteFailures: 0 };
    }
    this.running = true;
    try {
      // Expired-but-still-ACTIVE rows are retired first, so the sweep below
      // never even sees an alert whose evaluation is no longer authorised.
      const expired = await this.prisma.sentinelAlert.updateMany({
        where: { status: 'ACTIVE', expiresAt: { not: null, lte: at } },
        data: { status: 'EXPIRED', expiredAt: at },
      });

      const activeAlerts = await this.prisma.sentinelAlert.findMany({
        where: { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
        orderBy: { createdAt: 'asc' },
      });
      if (activeAlerts.length === 0) {
        return { activeAlerts: 0, evaluated: 0, triggered: 0, callsQueued: 0, gated: 0, expired: expired.count, quoteFailures: 0 };
      }

      // ONE QUOTE PER SYMBOL, SHARED BY EVERY ALERT ON THAT SYMBOL.
      const symbols = [...new Set(activeAlerts.map((alert) => alert.symbol))];
      const quotes = new Map<string, QuoteDto | 'PROVIDER_ERROR'>();
      for (const symbol of symbols) {
        try {
          quotes.set(symbol, await this.liveData.quote(symbol, at));
        } catch (error) {
          // A dead feed is a recorded problem, never a trigger: the affected
          // alerts stay ACTIVE and their observation is left untouched.
          this.logger.warn(
            `Quote fetch failed for ${symbol}: ${error instanceof Error ? error.message : 'unknown error'}; affected alerts stay ACTIVE.`,
          );
          quotes.set(symbol, 'PROVIDER_ERROR');
        }
      }

      let evaluated = 0;
      let triggered = 0;
      let callsQueued = 0;
      let gated = 0;
      let quoteFailures = 0;

      for (const alert of activeAlerts) {
        const quote = quotes.get(alert.symbol) ?? 'PROVIDER_ERROR';

        if (quote === 'PROVIDER_ERROR') {
          quoteFailures += 1;
          await this.recordObservation(alert, null, at, 'PROVIDER_ERROR');
          continue;
        }

        await this.recordObservation(alert, quote, at);
        const usable = quote.available && !quote.stale && quote.marketState === 'OPEN' && quote.price !== null;
        evaluated += 1;

        if (!usable) {
          // Keep the alert ACTIVE and let the observation say why nothing
          // happened. This is the difference between a quiet market and a
          // broken feed - both are surfaced, neither triggers.
          continue;
        }

        if (evaluateThreshold(alert.condition, alert.targetPrice, quote.price as string)) {
          const queued = await this.trigger(alert, quote as QuoteDto & { price: string }, at);
          triggered += 1;
          if (queued) callsQueued += 1;
          else gated += 1;
        }
      }

      return { activeAlerts: activeAlerts.length, evaluated, triggered, callsQueued, gated, expired: expired.count, quoteFailures };
    } finally {
      this.running = false;
    }
  }

  /*
   * Persists the observation and evaluation state for one alert.
   *
   * When the quote is unusable the previous observation is overwritten with
   * the truth of this instant ("market closed", or the last price the feed
   * printed) rather than left standing like something current.
   */
  private async recordObservation(alert: SentinelAlert, quote: QuoteDto | null, at: Date, failure?: 'PROVIDER_ERROR'): Promise<void> {
    const data =
      quote && quote.available
        ? ({
            observedPrice: quote.price === null ? undefined : new Prisma.Decimal(quote.price),
            observedAsOf: quote.asOf === null ? undefined : new Date(quote.asOf),
            observedProvider: quote.provider,
            observedMarketState: quote.marketState,
            observedStale: quote.stale,
            lastEvaluatedAt: at,
          } satisfies Prisma.SentinelAlertUpdateInput)
        : ({
            // No honest price: clear the stale one rather than rename it.
            observedPrice: null,
            observedAsOf: null,
            observedProvider: failure === 'PROVIDER_ERROR' ? 'none' : quote?.provider ?? 'none',
            observedMarketState: failure ?? quote?.marketState ?? 'UNKNOWN',
            observedStale: null,
            lastEvaluatedAt: at,
          } satisfies Prisma.SentinelAlertUpdateInput);

    await this.prisma.sentinelAlert.update({ where: { alertId: alert.alertId }, data });
  }

  /**
   * Claims an alert by guarded transition, then - in the same transaction -
   * queues its call row when voice is permitted.
   *
   * Returns whether a call was queued. A gated trigger still transitions the
   * alert (TRIGGERED, no follow-up) and records WHY no call follows, because
   * an alert whose target was met is finished either way; the voice gate
   * changes the notification channel, not the trigger.
   */
  private async trigger(alert: SentinelAlert, quote: QuoteDto & { price: string }, at: Date): Promise<boolean> {
    const gate = alert.voiceEnabled ? await this.decideCallGate(alert.ownerId, at) : ({ ok: false, reason: 'VOICE_OFF' } as const);

    // GUARDED TRANSITION. The loser of a race rewrites nothing: its WHERE
    // simply does not match anymore.
    const claimed = await this.prisma.sentinelAlert.updateMany({
      where: { alertId: alert.alertId, status: 'ACTIVE' },
      data: {
        status: gate.ok ? 'CALL_QUEUED' : 'TRIGGERED',
        triggeredAt: at,
        callSkipReason: gate.ok ? null : gate.reason,
      },
    });
    if (claimed.count === 0) {
      this.logger.debug(`Trigger race lost for alert ${alert.alertId}; another worker claimed it.`);
      return false;
    }

    if (gate.ok) {
      // The job and the trigger are one transaction: a crash between them
      // leaves either an ACTIVE alert or a TRIGGERED one WITH its job.
      await this.prisma.$transaction(async (tx) => {
        await tx.sentinelVoiceCall.create({
          data: {
            alertId: alert.alertId,
            status: 'QUEUED',
            maxAttempts: this.config.sentinel.callMaxAttempts,
            provider: this.config.sentinel.voiceProvider,
            spokenText: composeVoiceAlertMessage({
              instrumentName: alert.displayName,
              currency: alert.quoteCurrency,
              targetPrice: alert.targetPrice,
              observedPrice: new Prisma.Decimal(quote.price),
              condition: alert.condition,
              observedAsOf: quote.asOf as string,
            }),
            nextAttemptAt: at, // eligible immediately; retry passes pace redials
          },
        });
        await tx.sentinelAlert.update({
          where: { alertId: alert.alertId },
          data: { status: 'CALL_QUEUED' },
        });
      });
      return true;
    }

    return false;
  }

  /** The full gate, including the day's call budgets. */
  private async decideCallGate(ownerId: string, at: Date): Promise<{ ok: boolean; reason: SentinelCallGateReason | null }> {
    const reason = await this.voice.callGateFor(ownerId, at);
    if (reason !== null) return { ok: false, reason };

    const [userCalls, platformCalls] = await Promise.all([
      this.voice.userCallsInitiatedTodayUtc(ownerId, at),
      this.voice.platformCallsInitiatedTodayUtc(at),
    ]);
    if (userCalls >= this.config.sentinel.maxCallsPerUserPerDay) return { ok: false, reason: 'USER_DAILY_LIMIT' };
    if (platformCalls >= this.config.sentinel.maxCallsPlatformPerDay) return { ok: false, reason: 'PLATFORM_DAILY_LIMIT' };

    return { ok: true, reason: null };
  }
}

export interface SentinelMonitorPassStats {
  activeAlerts: number;
  evaluated: number;
  triggered: number;
  callsQueued: number;
  gated: number;
  expired: number;
  quoteFailures: number;
}

/** Type aid for the caller pass, which consumes the row shape it updates. */
export type SentinelCallJob = SentinelVoiceCall;
