import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SentinelAlert, SentinelVoiceCall } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import {
  VOICE_CALL_PROVIDER,
  type VoiceCallProvider,
  type VoiceWebhookInput,
  VoiceCallProviderError,
} from './providers/voice-call-provider.port';

/** The alert statuses that finally describe what happened to one alert. */
const TERMINAL_ALERT_STATUSES = ['CALL_COMPLETED', 'CALL_FAILED'] as const;

/**
 * MODULE 14 - the caller pass and the webhook door.
 *
 * TWO DRIVERS, ONE ROW. A call job advances from QUEUED through this pass
 * (which dials), and from CALLING through the webhook (which reports the
 * outcome). Both write through guarded updates keyed on the row's current
 * status, so a webhook that races a retry pass, or arrives twice as Twilio
 * sometimes does, cannot double-apply: the second update matches zero rows and
 * the row keeps exactly one history.
 *
 * THE PORT IS THE ONLY DOOR TO THE PHONE. This service never builds a TwiML
 * string and never stores a credential: it hands the provider the row's
 * recorded spoken text and the settings row's E.164 number, and stores back
 * what the provider reports. A provider refusing the dial is data, not a
 * stack trace: the failure class lands in `fail_reason`, the retry schedule in
 * `next_attempt_at`, and the unwanted detail goes nowhere.
 *
 * RECOVERY IS INHERENT, NOT A JOB. Every decision is read from the row
 * (status, attempts, next_attempt_at), so a pass after a process restart
 * simply sees the work that was pending and continues it - there is no
 * in-memory queue to lose.
 */
@Injectable()
export class SentinelCallerService {
  private readonly logger = new Logger(SentinelCallerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(VOICE_CALL_PROVIDER) private readonly provider: VoiceCallProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * One dial sweep: every job due now gets at most one attempt. `scopeOwnerId`
   * narrows the sweep to one owner's jobs - used by tests to keep assertions
   * hermetic across suite order - and is left undefined by the worker and the
   * run-once route, which sweep everything.
   */
  async runOnce(at: Date, scopeOwnerId?: string): Promise<SentinelCallerPassStats> {
    const due = await this.prisma.sentinelVoiceCall.findMany({
      where: {
        status: 'QUEUED',
        nextAttemptAt: { lte: at },
        ...(scopeOwnerId ? { alert: { ownerId: scopeOwnerId } } : {}),
      },
      orderBy: { queuedAt: 'asc' },
      take: 50,
      include: { alert: { select: { ownerId: true } } },
    });

    let initiated = 0;
    let retried = 0;
    let failed = 0;

    for (const job of due) {
      if (job.attempts >= job.maxAttempts) {
        await this.fail(job, at, 'RETRIES_EXHAUSTED');
        failed += 1;
        continue;
      }
      await this.attemptDial(job, at, (kind) => {
        if (kind === 'initiated') initiated += 1;
        else if (kind === 'retried') retried += 1;
        else failed += 1;
      });
    }

    return { considered: due.length, initiated, retried, failed };
  }

  /**
   * Processes one provider status callback.
   *
   * The provider instance verifies the request's signature against its own
   * credentials before anything here reads the payload; a request that fails
   * that check is a forged one and stops at the boundary. The unknown call id
   * is returned, not thrown: a webhook referencing a call this deployment
   * never made is suspicious but it is not a 500.
   */
  async processWebhook(input: VoiceWebhookInput, at: Date): Promise<SentinelWebhookResult> {
    const parsed = this.provider.verifyAndParseWebhook(input);
    if (!parsed.ok) {
      this.logger.warn(`Voice webhook refused: ${parsed.reason}.`);
      return { handled: false, refusal: parsed.reason };
    }

    const call = await this.prisma.sentinelVoiceCall.findUnique({
      where: { providerCallId: parsed.providerCallId },
      include: { alert: { select: { alertId: true, status: true } } },
    });
    if (call === null) {
      return { handled: false, refusal: 'WEBHOOK_UNKNOWN_CALL' };
    }

    switch (parsed.outcome) {
      case 'INITIATED':
        // A row already made the transition when the dial succeeded; this
        // progress event is idempotent housekeeping at most.
        await this.prisma.sentinelVoiceCall.updateMany({
          where: { callId: call.callId, status: { in: ['QUEUED'] } },
          data: { status: 'INITIATED', initiatedAt: at, providerCallId: parsed.providerCallId },
        });
        return { handled: true };

      case 'COMPLETED':
        await this.complete(call, at);
        return { handled: true };

      case 'CANCELED':
        await this.fail(call, at, 'CALL_CANCELED');
        return { handled: true };

      // BUSY and NO_ANSWER are real outcomes, not errors: they burn an
      // attempt with the dial pass's own accounting and re-join the retry
      // schedule if any budget remains.
      case 'BUSY':
      case 'NO_ANSWER': {
        const retriable = call.attempts < call.maxAttempts;
        if (retriable) {
          await this.scheduleRetry(call, at, parsed.outcome);
          return { handled: true, scheduledRetry: true };
        }
        await this.fail(call, at, parsed.outcome);
        return { handled: true };
      }

      case 'REJECTED':
      case 'FAILED':
        await this.fail(call, at, parsed.outcome === 'REJECTED' ? 'CALL_REJECTED' : 'CALL_FAILED_PROVIDER');
        return { handled: true };
    }
  }

  // ---------------------------------------------------------------------------
  // Dial flow
  // ---------------------------------------------------------------------------

  /**
   * Dials one job. The PROVIDER CALL is deliberately made OUTSIDE any open
   * transaction: no DB lock survives a 10-second network wait, and the row
   * itself (attempt count, guarded status) is the lock that two overlapping
   * passes would otherwise duplicate.
   */
  private async attemptDial(
    job: SentinelVoiceCall & { alert: { ownerId: string } },
    at: Date,
    onOutcome: (kind: 'initiated' | 'retried' | 'failed') => void,
  ): Promise<void> {
    const settings = await this.prisma.sentinelVoiceSetting.findUnique({ where: { userId: job.alert.ownerId } });
    if (settings?.phoneE164 === undefined || settings.phoneE164 === null || settings.phoneVerifiedAt === null) {
      // The gate changed under us (numbers are re-readable at any instant).
      // Rather than dial nothing and retry an impossible call, fail the job -
      // the reason is user-safe and the alert's history records it.
      await this.fail(job, at, 'PHONE_UNAVAILABLE');
      onOutcome('failed');
      return;
    }

    try {
      const result = await this.provider.dial({ to: settings.phoneE164, spokenText: job.spokenText ?? '' });
      const claimed = await this.prisma.sentinelVoiceCall.updateMany({
        where: { callId: job.callId, status: 'QUEUED' },
        data: {
          status: 'INITIATED',
          attempts: { increment: 1 },
          initiatedAt: at,
          providerCallId: result.providerCallId,
          failReason: null,
        },
      });
      if (claimed.count === 0) {
        // A webhook or another pass moved the row first. The provider call is
        // already out: it is a real attempt, whatever this pass's bookkeeping
        // says, so count it and let the webhook settle the outcome.
        this.logger.warn(`Dial race for call ${job.callId}: row left QUEUED before the result landed.`);
        return;
      }
      await this.prisma.sentinelAlert.update({
        where: { alertId: job.alertId },
        data: { status: 'CALLING' },
      });
      onOutcome('initiated');
    } catch (error) {
      const providerError = error instanceof VoiceCallProviderError ? error : null;
      const reason = providerError?.failReason ?? 'PROVIDER_ERROR';
      const retryable = providerError?.retryable === true && job.attempts + 1 < job.maxAttempts;

      if (retryable) {
        // Count the attempt and pace the next one; the row stays QUEUED.
        await this.prisma.sentinelVoiceCall.updateMany({
          where: { callId: job.callId, status: 'QUEUED' },
          data: {
            attempts: { increment: 1 },
            nextAttemptAt: new Date(at.getTime() + this.config.sentinel.callRetryDelayMs),
            failReason: reason,
          },
        });
        onOutcome('retried');
        return;
      }

      await this.fail(job, at, reason);
      onOutcome('failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------

  /** Schedules one retry after a busy/no-answer webhook, keeping the budget honest. */
  private async scheduleRetry(call: SentinelVoiceCall, at: Date, reason: string): Promise<void> {
    await this.prisma.sentinelVoiceCall.updateMany({
      where: { callId: call.callId, status: { in: ['INITIATED', 'QUEUED'] } },
      data: {
        status: 'QUEUED',
        attempts: { increment: 1 },
        nextAttemptAt: new Date(at.getTime() + this.config.sentinel.callRetryDelayMs),
        failReason: reason,
      },
    });
    // The alert does not go back to CALL_QUEUED over an outcome webhook while
    // a dial is live; it simply stays CALLING until the final word arrives.
  }

  /** Marks the call completed and settles the alert - guarded so a duplicate callback is a no-op. */
  private async complete(call: SentinelVoiceCall, at: Date): Promise<void> {
    const claimed = await this.prisma.sentinelVoiceCall.updateMany({
      where: { callId: call.callId, status: { not: { in: [...TERMINAL_CALL_STATUSES] } } },
      // nextAttemptAt is cleared: a settled call is never retried, and leaving
      // the stale schedule on the row makes history screens advertise a
      // "retry at" that can never happen.
      data: { status: 'COMPLETED', completedAt: at, nextAttemptAt: null },
    });
    if (claimed.count === 0) return;

    await this.prisma.sentinelAlert.updateMany({
      where: { alertId: call.alertId, status: { not: { in: [...TERMINAL_ALERT_STATUSES] } } },
      data: { status: 'CALL_COMPLETED' },
    });
  }

  /** Marks the call failed with a user-safe reason and settles the alert. */
  private async fail(call: SentinelVoiceCall, at: Date, reason: string): Promise<void> {
    const claimed = await this.prisma.sentinelVoiceCall.updateMany({
      where: { callId: call.callId, status: { not: { in: [...TERMINAL_CALL_STATUSES] } } },
      // Same as complete(): a FAILED row is terminal, so its retry schedule is
      // cleared rather than left to imply another attempt is coming.
      data: { status: 'FAILED', completedAt: at, failReason: reason, nextAttemptAt: null },
    });
    if (claimed.count === 0) return;

    await this.prisma.sentinelAlert.updateMany({
      where: { alertId: call.alertId, status: { not: { in: [...TERMINAL_ALERT_STATUSES] } } },
      data: { status: 'CALL_FAILED' },
    });
  }
}

const TERMINAL_CALL_STATUSES = ['COMPLETED', 'FAILED'] as const;

export interface SentinelCallerPassStats {
  considered: number;
  initiated: number;
  retried: number;
  failed: number;
}

export interface SentinelWebhookResult {
  readonly handled: boolean;
  readonly refusal?: string;
  readonly scheduledRetry?: boolean;
}

/** Kept for parity with the monitor's return shape: the row a pass advanced. */
export type SentinelCallRecord = SentinelVoiceCall;
