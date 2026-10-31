import { Inject, Injectable } from '@nestjs/common';
import type { SentinelAlert, SentinelVoiceCall } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';

/**
 * MODULE 14 - the in-app simulated-call surface for the `fake` provider.
 *
 * WHY THIS EXISTS. Twilio places a real PSTN call; the `fake` provider places
 * none, so without a surface here a triggered alert would leave a call row
 * stuck in `INITIATED` with nobody ever shown a ringing phone. This service is
 * that missing surface: it hands the signed-in owner the one of their calls
 * that is ringing right now, and applies the user's Answer/Decline back onto
 * the SAME guarded transitions the webhook path uses, so a fake outcome and a
 * provider outcome write history identically.
 *
 * IT IS A SIMULATION, NEVER A REAL CALL. Nothing here touches a network. The
 * outcome endpoint is only reachable while `voiceProvider === 'fake'`; under
 * Twilio the real call's outcome must come from the provider's signed webhook,
 * and this service refuses rather than letting a browser claim a Twilio call
 * connected (requirement: never fabricate a successful real telephone call).
 *
 * OWNERSHIP IS THE TOKEN. Every read and write is scoped to `ownerId`; there
 * is no route that accepts a user id, so one user cannot see, answer or fail
 * another's ringing call - the same posture as the rest of the controller.
 *
 * THE MESSAGE IS NEVER RECOMPOSED. The row carries `spokenText`, the exact
 * text the monitor composed at trigger time; the UI speaks that verbatim, so
 * what the user reads and what a real provider would have said cannot diverge.
 */

/** The live-call projection returned to the browser (no provider internals). */
export interface SentinelLiveCall {
  readonly callId: string;
  readonly status: SentinelVoiceCall['status'];
  readonly attempts: number;
  readonly maxAttempts: number;
  /** True while the simulated phone is still ringing and can be answered. */
  readonly ringing: boolean;
  readonly queuedAt: string;
  readonly initiatedAt: string | null;
  readonly completedAt: string | null;
  readonly failReason: string | null;
  readonly nextAttemptAt: string | null;
  /** The exact text to speak. May be empty if a job queued without one. */
  readonly spokenText: string;
  /** Declared so the client can label the experience as a simulation. */
  readonly simulated: boolean;
  readonly alert: {
    readonly alertId: string;
    readonly symbol: string;
    readonly displayName: string;
    readonly quoteCurrency: string;
    readonly targetPrice: string;
    readonly condition: SentinelAlert['condition'];
    readonly observedPrice: string | null;
    readonly observedAsOf: string | null;
    readonly status: SentinelAlert['status'];
  };
}

type LiveRow = SentinelVoiceCall & { alert: SentinelAlert };

const TERMINAL_CALL_STATUSES = ['COMPLETED', 'FAILED'] as const;
const TERMINAL_ALERT_STATUSES = ['CALL_COMPLETED', 'CALL_FAILED'] as const;

function toLiveCall(row: LiveRow): SentinelLiveCall {
  return {
    callId: row.callId,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ringing: row.status === 'INITIATED' && row.completedAt === null,
    queuedAt: row.queuedAt.toISOString(),
    initiatedAt: row.initiatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    failReason: row.failReason,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    spokenText: row.spokenText ?? '',
    simulated: row.provider === 'fake',
    alert: {
      alertId: row.alert.alertId,
      symbol: row.alert.symbol,
      displayName: row.alert.displayName,
      quoteCurrency: row.alert.quoteCurrency,
      targetPrice: String(row.alert.targetPrice),
      condition: row.alert.condition,
      observedPrice: row.alert.observedPrice === null ? null : String(row.alert.observedPrice),
      observedAsOf: row.alert.observedAsOf?.toISOString() ?? null,
      status: row.alert.status,
    },
  };
}

@Injectable()
export class SentinelLiveCallService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The owner's ringing call, or null.
   *
   * "Ringing" is a row the caller pass has already dialled but that has not
   * settled: status `INITIATED` with no completion. QUEUED rows are withheld -
   * the provider has not accepted them yet, so there is nothing to answer -
   * and a settled row is history, not a live call. Scoped to the fake
   * provider: a Twilio row in `INITIATED` is ringing on the PSTN, and
   * surfacing it here would invite a fake "answered" claim about a real call.
   */
  async ringingCallFor(ownerId: string): Promise<SentinelLiveCall | null> {
    const call = await this.prisma.sentinelVoiceCall.findFirst({
      where: {
        status: 'INITIATED',
        completedAt: null,
        provider: 'fake',
        alert: { ownerId },
      },
      orderBy: { initiatedAt: 'desc' },
      include: { alert: true },
    });

    return call === null ? null : toLiveCall(call);
  }

  /**
   * Applies the user's decision to their own ringing call.
   *
   * The transition runs through updates keyed on the row's current status, so
   * a double-tap, a replayed request, or a race with the caller's retry pass
   * cannot double-settle: the second write matches zero rows and the first
   * outcome stands. The result is reported idempotently - the row's resulting
   * state - because "the user tapped Answer twice" is not a failure.
   */
  async settleLiveCall(
    ownerId: string,
    input: { callId: string; action: 'ANSWERED' | 'DECLINED' | 'ENDED'; at: Date },
  ): Promise<SentinelLiveCall> {
    if (this.config.sentinel.voiceProvider !== 'fake') {
      // Honest refusal: a browser cannot report an outcome for a real call.
      throw DomainException.badRequest(
        'Simulated in-app calls are only available while SENTINEL_VOICE_PROVIDER=fake.',
      );
    }

    const call = await this.prisma.sentinelVoiceCall.findFirst({
      where: { callId: input.callId, provider: 'fake', alert: { ownerId } },
      include: { alert: true },
    });
    if (call === null) {
      throw DomainException.notFound('Call', input.callId);
    }

    // Already settled, or never rang: report the truth rather than re-running
    // a transition. A duplicate action is a no-op, not an error.
    if (call.status !== 'INITIATED' || call.completedAt !== null) {
      return toLiveCall(call);
    }

    switch (input.action) {
      case 'ANSWERED':
      case 'ENDED':
        // Answered (and possibly hung up early): either way the phone rang on
        // this device and was picked up, so the call connected and is heard.
        // Ending never trades anything - there is no trade path here at all.
        await this.settle(call, input.at, { status: 'COMPLETED' }, 'CALL_COMPLETED');
        break;

      case 'DECLINED':
        // The user actively refused. NO_ANSWER is the honest outcome and, like
        // a carrier's no-answer, it re-joins the retry schedule if budget
        // remains rather than pretending the call was answered.
        await this.applyDecline(call, input.at);
        break;
    }

    const after = await this.prisma.sentinelVoiceCall.findUnique({
      where: { callId: call.callId },
      include: { alert: true },
    });
    return toLiveCall(after!);
  }

  /** Decline burns the attempt and either schedules a redial or fails the job. */
  private async applyDecline(call: LiveRow, at: Date): Promise<void> {
    const budgetLeft = call.attempts < call.maxAttempts;
    if (budgetLeft) {
      await this.prisma.sentinelVoiceCall.updateMany({
        where: { callId: call.callId, status: 'INITIATED' },
        data: {
          status: 'QUEUED',
          attempts: { increment: 1 },
          nextAttemptAt: new Date(at.getTime() + this.config.sentinel.callRetryDelayMs),
          failReason: 'NO_ANSWER',
        },
      });
      return;
    }
    await this.settle(call, at, { status: 'FAILED', failReason: 'NO_ANSWER' }, 'CALL_FAILED');
  }

  /**
   * One guarded write for the call row and, if it won, one for the alert - both
   * keyed off "not already terminal", so a duplicate request matches zero rows
   * and leaves the single recorded outcome untouched.
   */
  private async settle(
    call: LiveRow,
    at: Date,
    callData: { status: 'COMPLETED' | 'FAILED'; failReason?: string },
    alertStatus: 'CALL_COMPLETED' | 'CALL_FAILED',
  ): Promise<void> {
    const callUpdate = await this.prisma.sentinelVoiceCall.updateMany({
      where: { callId: call.callId, status: { not: { in: [...TERMINAL_CALL_STATUSES] } } },
      data: {
        status: callData.status,
        completedAt: at,
        // Terminal: the retry schedule is cleared so history never advertises
        // a "retry at" that cannot happen (same rule the caller's own
        // settle paths follow).
        nextAttemptAt: null,
        ...(callData.failReason !== undefined ? { failReason: callData.failReason } : {}),
      },
    });
    if (callUpdate.count === 0) return;

    await this.prisma.sentinelAlert.updateMany({
      where: { alertId: call.alertId, status: { not: { in: [...TERMINAL_ALERT_STATUSES] } } },
      data: { status: alertStatus },
    });
  }
}
