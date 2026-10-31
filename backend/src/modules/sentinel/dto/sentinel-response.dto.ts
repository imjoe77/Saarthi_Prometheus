import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SentinelAlert, SentinelVoiceCall } from '@prisma/client';

import type { SentinelLiveCall } from '../sentinel-live-call.service';
import type { SentinelVoiceService } from '../sentinel-voice.service';

/**
 * MODULE 14 - response shapes.
 *
 * WHAT LEAVES HERE IS WHAT A BROWSER MAY SEE. No provider credentials, no raw
 * phone number (the settings response carries the mask), no carrier internals
 * - only the user-safe failure classes the caller writes. Decimals travel as
 * the exact strings Prisma stored them as.
 */

/** The alert row as the service returns it, with the latest call attached. */
export type AlertWithCall = SentinelAlert & { calls: SentinelVoiceCall[] };

/** The call-history row: the call flattened with the alert it belongs to. */
export type CallHistoryRow = SentinelVoiceCall & {
  alert: { symbol: string; displayName: string; targetPrice: unknown; condition: string; quoteCurrency: string };
};

export class CallSummaryDto {
  @ApiProperty() callId!: string;
  @ApiProperty({ enum: ['QUEUED', 'INITIATED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'REJECTED', 'CANCELED', 'FAILED'] }) status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiPropertyOptional({ nullable: true }) providerCallId!: string | null;
  @ApiProperty() queuedAt!: string;
  @ApiPropertyOptional({ nullable: true }) initiatedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) failReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) nextAttemptAt!: string | null;

  static from(call: SentinelVoiceCall): CallSummaryDto {
    return {
      callId: call.callId,
      status: call.status,
      attempts: call.attempts,
      maxAttempts: call.maxAttempts,
      // The provider's reference is internal plumbing: shown as an existence
      // marker rather than handed through.
      providerCallId: call.providerCallId === null ? null : ' ••• ',
      queuedAt: call.queuedAt.toISOString(),
      initiatedAt: call.initiatedAt?.toISOString() ?? null,
      completedAt: call.completedAt?.toISOString() ?? null,
      failReason: call.failReason,
      nextAttemptAt: call.nextAttemptAt?.toISOString() ?? null,
    };
  }
}

export class AlertResponseDto {
  @ApiProperty() alertId!: string;
  @ApiProperty() symbol!: string;
  @ApiProperty() exchange!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() quoteCurrency!: string;
  @ApiProperty() targetPrice!: string;
  @ApiProperty({ enum: ['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL'] }) condition!: string;
  @ApiProperty({ enum: ['ACTIVE', 'TRIGGERED', 'CALL_QUEUED', 'CALLING', 'CALL_COMPLETED', 'CALL_FAILED', 'CANCELLED', 'EXPIRED'] }) status!: string;
  @ApiProperty() voiceEnabled!: boolean;

  @ApiPropertyOptional({ nullable: true }) observedPrice!: string | null;
  @ApiPropertyOptional({ nullable: true }) observedAsOf!: string | null;
  @ApiPropertyOptional({ nullable: true }) observedProvider!: string | null;
  @ApiPropertyOptional({ nullable: true }) observedMarketState!: string | null;
  @ApiPropertyOptional({ nullable: true, type: Boolean }) observedStale!: boolean | null;
  @ApiPropertyOptional({ nullable: true }) lastEvaluatedAt!: string | null;

  @ApiPropertyOptional({ nullable: true }) expiresAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) triggeredAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelledAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) callSkipReason!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  @ApiPropertyOptional({ type: CallSummaryDto, nullable: true }) call?: CallSummaryDto | null;

  static from(alert: SentinelAlert, call?: SentinelVoiceCall | null): AlertResponseDto {
    return {
      alertId: alert.alertId,
      symbol: alert.symbol,
      exchange: alert.exchange,
      displayName: alert.displayName,
      quoteCurrency: alert.quoteCurrency,
      targetPrice: String(alert.targetPrice),
      condition: alert.condition,
      status: alert.status,
      voiceEnabled: alert.voiceEnabled,
      observedPrice: alert.observedPrice === null ? null : String(alert.observedPrice),
      observedAsOf: alert.observedAsOf?.toISOString() ?? null,
      observedProvider: alert.observedProvider,
      observedMarketState: alert.observedMarketState,
      observedStale: alert.observedStale,
      lastEvaluatedAt: alert.lastEvaluatedAt?.toISOString() ?? null,
      expiresAt: alert.expiresAt?.toISOString() ?? null,
      triggeredAt: alert.triggeredAt?.toISOString() ?? null,
      cancelledAt: alert.cancelledAt?.toISOString() ?? null,
      cancelReason: alert.cancelReason,
      callSkipReason: alert.callSkipReason,
      createdAt: alert.createdAt.toISOString(),
      updatedAt: alert.updatedAt.toISOString(),
      call: call ? CallSummaryDto.from(call) : null,
    };
  }
}

export class AlertPageDto {
  @ApiProperty({ type: [AlertResponseDto] }) items!: AlertResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;

  static from(result: {
    items: AlertWithCall[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }): AlertPageDto {
    return {
      items: result.items.map((alert) => AlertResponseDto.from(alert, alert.calls?.[0] ?? null)),
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    };
  }
}

export class CallHistoryItemDto {
  @ApiProperty({ type: CallSummaryDto }) call!: CallSummaryDto;
  @ApiProperty() symbol!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() targetPrice!: string;
  @ApiProperty() condition!: string;
  @ApiProperty() quoteCurrency!: string;

  static from(row: CallHistoryRow): CallHistoryItemDto {
    return {
      call: CallSummaryDto.from(row),
      symbol: row.alert.symbol,
      displayName: row.alert.displayName,
      targetPrice: String(row.alert.targetPrice),
      condition: row.alert.condition,
      quoteCurrency: row.alert.quoteCurrency,
    };
  }
}

export class CallHistoryPageDto {
  @ApiProperty({ type: [CallHistoryItemDto] }) items!: CallHistoryItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;

  static from(result: { items: CallHistoryRow[]; page: number; limit: number; total: number; totalPages: number }): CallHistoryPageDto {
    return {
      items: result.items.map((row) => CallHistoryItemDto.from(row)),
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    };
  }
}

export class VoiceSettingsResponseDto {
  @ApiProperty({ nullable: true }) phoneMasked!: string | null;
  @ApiProperty() phoneVerified!: boolean;
  @ApiProperty() consented!: boolean;
  @ApiPropertyOptional({ nullable: true }) consentAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) consentWithdrawnAt!: string | null;
  @ApiProperty() voiceDisabled!: boolean;
  @ApiPropertyOptional({ nullable: true, type: Number }) quietHoursStartUtc!: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) quietHoursEndUtc!: number | null;

  static from(publics: ReturnType<SentinelVoiceService['toPublicSettings']>): VoiceSettingsResponseDto {
    return { ...publics };
  }
}

export class VerificationResponseDto {
  @ApiProperty({ enum: ['ISSUED', 'ISSUED_DELIVERY_PENDING'] }) status!: string;
  @ApiPropertyOptional({ description: 'Present only where the platform can honestly deliver the code (never production).' })
  code?: string;
}

export class SentinelStatusResponseDto {
  @ApiProperty({ enum: ['off', 'fake', 'twilio'] }) voiceProvider!: string;
  @ApiProperty() workerEnabled!: boolean;
  @ApiProperty() activeAlerts!: number;
  @ApiProperty() triggeredAlerts!: number;
  @ApiProperty() cancelledAlerts!: number;
  @ApiProperty() expiredAlerts!: number;
  @ApiProperty() pendingCalls!: number;
  @ApiProperty() completedCalls!: number;
  @ApiProperty() failedCalls!: number;
  @ApiProperty() callsUsedTodayUtc!: number;
  @ApiProperty() maxCallsPerUserPerDay!: number;
  @ApiProperty() callGate!: string;
  @ApiProperty({ type: VoiceSettingsResponseDto }) voiceSettings!: VoiceSettingsResponseDto;

  static from(view: {
    voiceProvider: 'off' | 'fake' | 'twilio';
    workerEnabled: boolean;
    activeAlerts: number;
    triggeredAlerts: number;
    cancelledAlerts: number;
    expiredAlerts: number;
    pendingCalls: number;
    completedCalls: number;
    failedCalls: number;
    callsUsedTodayUtc: number;
    maxCallsPerUserPerDay: number;
    callGate: string;
    voiceSettings: ReturnType<SentinelVoiceService['toPublicSettings']>;
  }): SentinelStatusResponseDto {
    return { ...view, voiceSettings: VoiceSettingsResponseDto.from(view.voiceSettings) };
  }
}

export class PassResponseDto {
  @ApiProperty() monitor!: { activeAlerts: number; evaluated: number; triggered: number; callsQueued: number; gated: number; expired: number; quoteFailures: number };
  @ApiProperty() caller!: { considered: number; initiated: number; retried: number; failed: number };
}

/**
 * The in-app simulated call, as the browser may see it.
 *
 * Carries the alert facts a caller-ID screen would show plus the exact
 * `spokenText` the monitor composed at trigger time (so the UI speaks verbatim
 * what a real provider would have said) and a `simulated` flag the UI is
 * required to display. Never exposes a raw phone number or provider internals.
 */
export class LiveCallResponseDto {
  @ApiProperty() callId!: string;
  @ApiProperty({ enum: ['QUEUED', 'INITIATED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'REJECTED', 'CANCELED', 'FAILED'] })
  status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty({ description: 'True while the simulated phone is still ringing and can be answered.' })
  ringing!: boolean;
  @ApiProperty() queuedAt!: string;
  @ApiPropertyOptional({ nullable: true }) initiatedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) failReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) nextAttemptAt!: string | null;
  @ApiProperty({ description: 'The exact text to speak, composed by the monitor at trigger time.' })
  spokenText!: string;
  @ApiProperty({ description: 'Always true for this endpoint: a simulated in-app call, never a PSTN call.' })
  simulated!: boolean;
  @ApiProperty({
    type: 'object',
    description: 'The alert facts shown on the caller-ID card.',
    properties: {
      alertId: { type: 'string' },
      symbol: { type: 'string' },
      displayName: { type: 'string' },
      quoteCurrency: { type: 'string' },
      targetPrice: { type: 'string' },
      condition: { type: 'string', enum: ['GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL'] },
      observedPrice: { type: 'string', nullable: true },
      observedAsOf: { type: 'string', nullable: true },
      status: { type: 'string' },
    },
  })
  alert!: SentinelLiveCall['alert'];

  static from(call: SentinelLiveCall): LiveCallResponseDto {
    return { ...call };
  }
}

/**
 * `GET sentinel/voice/live`'s explicit envelope.
 *
 * Nest's Express adapter answers a nil body with an EMPTY response, so a bare
 * `null` would reach the browser as `""` rather than a parsed null and every
 * client would have to special-case it. Wrapping in `{ call }` keeps the wire
 * format unambiguous: `{ call: null }` is "nothing ringing" and never
 * indistinguishable from a failed or truncated response.
 */
export class LiveCallEnvelopeResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'The ringing simulated call, or null when nothing is ringing.',
    type: LiveCallResponseDto,
  })
  call!: LiveCallResponseDto | null;
}
