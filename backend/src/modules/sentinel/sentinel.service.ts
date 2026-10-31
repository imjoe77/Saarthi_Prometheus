import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type SentinelAlert } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { findInstrument } from '../live-data/instruments/instrument-catalogue';
import { SentinelVoiceService } from './sentinel-voice.service';
import type { AlertWithCall, CallHistoryRow } from './dto/sentinel-response.dto';

export interface SentinelPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** Capability statuses: only these may be edited; only these may be cancelled. */
const EDITABLE_STATUSES: SentinelAlert['status'][] = ['ACTIVE'];
const CANCELLABLE_STATUSES: SentinelAlert['status'][] = ['ACTIVE', 'TRIGGERED', 'CALL_QUEUED', 'CALLING'];

/**
 * MODULE 14 - alert configuration, ownership and reads.
 *
 * OWNERSHIP IS THE CALLER, NEVER A BODY FIELD. Every method takes the owner id
 * from the verified token; no route accepts a userId, so there is no handle a
 * caller could use to reach somebody else's alert. An alert that exists but
 * is not the caller's reads as NOT_FOUND, exactly like the copy module's
 * posture: "not yours" and "does not exist" stay indistinguishable.
 *
 * SYMBOLS ARE THE CATALOGUE, NOT STRINGS. A create or edit revalidates the
 * symbol against Module 06c's instrument universe, and an unknown symbol is a
 * 404 in that universe rather than a row Sentinel would silently never fire.
 *
 * ONLY THE FUTURE IS EDITABLE. An alert's meaning may change while it is
 * ACTIVE; once it has triggered, its history is written and a body swap would
 * forge it - so edit is refused for anything not ACTIVE, and cancellation
 * (which keeps the row but stops it) is allowed a little further into the
 * lifecycle: while a call is still pending, the owner may still stop it.
 */
@Injectable()
export class SentinelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly voice: SentinelVoiceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Creates an alert owned by the caller. */
  async create(
    ownerId: string,
    input: {
      symbol: string;
      displayName: string;
      targetPrice: string;
      condition: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL';
      expiresAt?: string | null;
      voiceEnabled: boolean;
    },
  ): Promise<AlertWithCall> {
    const instrument = findInstrument(input.symbol);
    if (instrument === null) {
      throw DomainException.notFound('Instrument', input.symbol);
    }

    const target = new Prisma.Decimal(input.targetPrice as Prisma.Decimal.Value);
    if (!target.isFinite() || target.lte(0)) {
      throw DomainException.badRequest('targetPrice must be a decimal greater than zero.');
    }

    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw DomainException.badRequest('expiresAt must be an RFC 3339 instant in the future.');
      }
    }

    // The abuse rail is a count of live configuration, checked here so the
    // refusal happens at the create, where the user can see it.
    const activeCount = await this.prisma.sentinelAlert.count({
      where: { ownerId, status: 'ACTIVE' },
    });
    if (activeCount >= this.config.sentinel.maxActiveAlertsPerUser) {
      throw DomainException.conflict(
        `You already have ${activeCount} active alert(s); cancel one before creating another. The limit is ${this.config.sentinel.maxActiveAlertsPerUser}.`,
      );
    }

    // Voice-on alerts must pass the settings gate at create time too, so an
    // alert that can never call is not silently configured to try. Alerts-only
    // rows (voiceEnabled false) are exempt: they need no phone.
    if (input.voiceEnabled) {
      const gate = await this.voice.callGateFor(ownerId, new Date());
      if (gate === 'PROVIDER_OFF' || gate === 'VOICE_OFF' || gate === 'PHONE_UNVERIFIED' || gate === 'CONSENT_MISSING') {
        throw DomainException.badRequest(
          `Voice calling is not available for this account yet (${gate}). Disable voice on the alert, or complete phone verification and consent first.`,
        );
      }
    }

    return this.prisma.sentinelAlert.create({
      data: {
        ownerId,
        symbol: instrument.symbol,
        exchange: instrument.venue,
        displayName: input.displayName,
        quoteCurrency: instrument.quoteCurrency,
        targetPrice: target,
        condition: input.condition,
        expiresAt,
        voiceEnabled: input.voiceEnabled,
      },
      include: { calls: true },
    });
  }

  /** The caller's own alerts, newest first, paged, each with its latest call. */
  async list(
    ownerId: string,
    page: number,
    limit: number,
    status?: SentinelAlert['status'],
  ): Promise<SentinelPage<AlertWithCall>> {
    const where: Prisma.SentinelAlertWhereInput = { ownerId, ...(status ? { status } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.sentinelAlert.count({ where }),
      this.prisma.sentinelAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { calls: { orderBy: { queuedAt: 'desc' }, take: 1 } },
      }),
    ]);

    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** One owned alert, including its latest call attempt. */
  async get(ownerId: string, alertId: string): Promise<AlertWithCall> {
    const alert = await this.prisma.sentinelAlert.findFirst({
      where: { alertId, ownerId },
      include: { calls: { orderBy: { queuedAt: 'desc' }, take: 1 } },
    });
    if (alert === null) {
      throw DomainException.notFound('Alert', alertId);
    }
    return alert;
  }

  /**
   * Edits the meaning of an ACTIVE alert. Anything further along is history.
   *
   * The whole map is built first and persisted once, so a body carrying two
   * valid fields and one invalid one changes nothing: the guards all run
   * before the single write.
   */
  async edit(
    ownerId: string,
    alertId: string,
    input: {
      targetPrice?: string;
      condition?: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL';
      expiresAt?: string | null;
      voiceEnabled?: boolean;
      displayName?: string;
    },
  ): Promise<AlertWithCall> {
    const existing = await this.ownedOrNotFound(ownerId, alertId);
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      throw DomainException.conflict(`Alert ${alertId} is ${existing.status} and can no longer be edited.`);
    }

    const data: Prisma.SentinelAlertUpdateInput = {};
    if (input.targetPrice !== undefined) {
      const target = new Prisma.Decimal(input.targetPrice as Prisma.Decimal.Value);
      if (!target.isFinite() || target.lte(0)) {
        throw DomainException.badRequest('targetPrice must be a decimal greater than zero.');
      }
      data.targetPrice = target;
    }
    if (input.condition !== undefined) data.condition = input.condition;
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.expiresAt !== undefined) {
      if (input.expiresAt === null) {
        data.expiresAt = null;
      } else {
        const expiry = new Date(input.expiresAt);
        if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
          throw DomainException.badRequest('expiresAt must be an RFC 3339 instant in the future.');
        }
        data.expiresAt = expiry;
      }
    }
    if (input.voiceEnabled !== undefined) {
      if (input.voiceEnabled) {
        const gate = await this.voice.callGateFor(ownerId, new Date());
        if (gate === 'PROVIDER_OFF' || gate === 'VOICE_OFF' || gate === 'PHONE_UNVERIFIED' || gate === 'CONSENT_MISSING') {
          throw DomainException.badRequest(
            `Voice calling is not available for this account yet (${gate}).`,
          );
        }
      }
      data.voiceEnabled = input.voiceEnabled;
      if (input.voiceEnabled) data.callSkipReason = null;
    }

    // The write the whole method exists for. An empty map is a no-op read,
    // which keeps "edit with nothing new" idempotent rather than a wasted row
    // bumping `updated_at` on a history row.
    if (Object.keys(data).length > 0) {
      await this.prisma.sentinelAlert.update({ where: { alertId }, data });
    }

    return this.get(ownerId, alertId);
  }

  /**
   * Cancels an alert. Cancellation keeps the row: the target was real, the
   * decision was real, and history records both. A pending call job is left to
   * the caller service to discover (a cancelled alert never dials).
   */
  async cancel(ownerId: string, alertId: string, reason: string): Promise<AlertWithCall> {
    const existing = await this.ownedOrNotFound(ownerId, alertId);
    if (!CANCELLABLE_STATUSES.includes(existing.status)) {
      throw DomainException.conflict(`Alert ${alertId} is ${existing.status} and cannot be cancelled.`);
    }

    const at = new Date();
    const claimed = await this.prisma.sentinelAlert.updateMany({
      where: {
        alertId,
        status: { in: [...CANCELLABLE_STATUSES] },
      },
      data: { status: 'CANCELLED', cancelledAt: at, cancelReason: reason },
    });
    if (claimed.count === 0) {
      throw DomainException.conflict(`Alert ${alertId} is ${existing.status} and cannot be cancelled.`);
    }

    // Any queued job for a not-yet-dialled alert must not dial after this.
    await this.prisma.sentinelVoiceCall.updateMany({
      where: { alertId, status: 'QUEUED' },
      data: { status: 'FAILED', completedAt: at, failReason: 'ALERT_CANCELLED' },
    });

    return this.get(ownerId, alertId);
  }

  /** The caller's own call history across all alerts, newest first, paged. */
  async callHistory(ownerId: string, page: number, limit: number): Promise<SentinelPage<CallHistoryRow>> {    const where: Prisma.SentinelVoiceCallWhereInput = { alert: { ownerId } };
    const [total, items] = await Promise.all([
      this.prisma.sentinelVoiceCall.count({ where }),
      this.prisma.sentinelVoiceCall.findMany({
        where,
        orderBy: { queuedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          alert: {
            select: { displayName: true, targetPrice: true, condition: true, quoteCurrency: true, symbol: true },
          },
        },
      }),
    ]);

    return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  /**
   * Sentinel's own status view: counts, feature state and the health signals
   * needed to answer "why has nothing fired?" with something useful.
   */
  async status(ownerId: string, at: Date): Promise<SentinelStatusView> {
    const [active, triggered, cancelled, expired, failedCalls, completedCalls, pendingCalls] = await Promise.all([
      this.prisma.sentinelAlert.count({ where: { ownerId, status: 'ACTIVE' } }),
      this.prisma.sentinelAlert.count({ where: { ownerId, status: { in: ['TRIGGERED', 'CALL_QUEUED', 'CALLING', 'CALL_COMPLETED'] } } }),
      this.prisma.sentinelAlert.count({ where: { ownerId, status: 'CANCELLED' } }),
      this.prisma.sentinelAlert.count({ where: { ownerId, status: 'EXPIRED' } }),
      this.prisma.sentinelVoiceCall.count({ where: { alert: { ownerId }, status: 'FAILED' } }),
      this.prisma.sentinelVoiceCall.count({ where: { alert: { ownerId }, status: 'COMPLETED' } }),
      this.prisma.sentinelVoiceCall.count({ where: { alert: { ownerId }, status: { in: ['QUEUED', 'INITIATED'] } } }),
    ]);

    const settings = await this.voice.settingsFor(ownerId);
    const gate = await this.voice.callGateFor(ownerId, at);

    return {
      voiceProvider: this.config.sentinel.voiceProvider,
      workerEnabled: this.config.sentinel.workerEnabled,
      activeAlerts: active,
      triggeredAlerts: triggered,
      cancelledAlerts: cancelled,
      expiredAlerts: expired,
      pendingCalls,
      completedCalls,
      failedCalls,
      callsUsedTodayUtc: await this.voice.userCallsInitiatedTodayUtc(ownerId, at),
      maxCallsPerUserPerDay: this.config.sentinel.maxCallsPerUserPerDay,
      callGate: gate ?? 'OK',
      voiceSettings: this.voice.toPublicSettings(settings),
    };
  }

  /** Ownership-or-404, the shared read. */
  private async ownedOrNotFound(ownerId: string, alertId: string): Promise<SentinelAlert> {
    const alert = await this.prisma.sentinelAlert.findFirst({ where: { alertId, ownerId } });
    if (alert === null) {
      // Not-found, not 403: a caller must not be able to establish that an id exists.
      throw DomainException.notFound('Alert', alertId);
    }
    return alert;
  }
}

export interface SentinelStatusView {
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
  /** `OK`, or the gate reason the next call would be refused for. */
  callGate: string;
  voiceSettings: ReturnType<SentinelVoiceService['toPublicSettings']>;
}
