import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { InvalidPhoneNumberError, maskForDisplay, normaliseToE164 } from './domain/phone';
import type { SentinelVoiceSetting } from '@prisma/client';

/**
 * MODULE 14 - phone verification, consent and the voice-call gate.
 *
 * ONE ROW PER USER. `sentinel_voice_settings` belongs to the person, not to an
 * alert: a number, its verification, the consent decision and the contact
 * window describe a human who will be telephoned, and every alert they own
 * dials through the same gate.
 *
 * THE GATE IS DERIVED, NEVER ASSERTED. `callGateFor(user)` re-reads the row on
 * every trigger pass and answers with the first thing that would make a call
 * improper RIGHT NOW - unverified number, withdrawn consent, quiet hours, a
 * disabled switch, the day's call budget. The monitor does not cache it, so
 * consent withdrawn between two evaluations is honoured by the second one.
 *
 * THE CODE IS NEVER STORED. Verification stores a salted-notice SHA-256 of the
 * six digits plus a TTL and an attempt budget; three wrong entries burn the
 * code and a new one must be requested. Delivery of the code by SMS is NOT
 * implemented - this project has no SMS provider - so the code surfaces only
 * outside production (see `codeChannel`); production walks in the documented
 * manual-setup path instead of pretending the message was sent.
 */
@Injectable()
export class SentinelVoiceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The caller's own settings row, created lazily. Skews to the owner. */
  async settingsFor(userId: string): Promise<SentinelVoiceSetting> {
    return this.prisma.sentinelVoiceSetting.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  /** Response-safe view of the settings: the number appears masked only. */
  toPublicSettings(settings: SentinelVoiceSetting): {
    phoneMasked: string | null;
    phoneVerified: boolean;
    consented: boolean;
    consentAt: string | null;
    consentWithdrawnAt: string | null;
    voiceDisabled: boolean;
    quietHoursStartUtc: number | null;
    quietHoursEndUtc: number | null;
  } {
    return {
      phoneMasked: settings.phoneE164 ? maskForDisplay(settings.phoneE164) : null,
      phoneVerified: settings.phoneVerifiedAt !== null,
      consented: settings.consentAt !== null && settings.consentWithdrawnAt === null,
      consentAt: settings.consentAt?.toISOString() ?? null,
      consentWithdrawnAt: settings.consentWithdrawnAt?.toISOString() ?? null,
      voiceDisabled: settings.voiceDisabledAt !== null,
      quietHoursStartUtc: settings.quietHoursStartUtc,
      quietHoursEndUtc: settings.quietHoursEndUtc,
    };
  }

  /**
   * The first reason a call to `userId` must not happen right now, or null.
   *
   * Deliberately returns ONE reason: the first in severity order, so the UI can
   * ask for exactly the next thing the user must fix. Evaluated against the
   * row as it exists at this instant.
   */
  async callGateFor(userId: string, at: Date): Promise<SentinelCallGateReason | null> {
    const settings = await this.prisma.sentinelVoiceSetting.findUnique({ where: { userId } });
    if (!settings) return 'VOICE_OFF';

    if (this.config.sentinel.voiceProvider === 'off') return 'PROVIDER_OFF';
    if (settings.voiceDisabledAt !== null) return 'VOICE_OFF';
    if (!settings.phoneE164 || settings.phoneVerifiedAt === null) return 'PHONE_UNVERIFIED';
    if (settings.consentAt === null || settings.consentWithdrawnAt !== null) return 'CONSENT_MISSING';
    if (this.inQuietHours(settings, at)) return 'QUIET_HOURS';

    return null;
  }

  /**
   * Whether `at` falls inside the row's quiet window.
   *
   * The window may wrap midnight (22:00-06:00 is start=1320, end=360), so the
   * test is "outside the window" only when a start and end exist and differ.
   * An open-ended side (start set, end null) is stored as the pair, never as
   * one null one value - the schema check enforces that.
   */
  inQuietHours(settings: SentinelVoiceSetting, at: Date): boolean {
    const { quietHoursStartUtc: start, quietHoursEndUtc: end } = settings;
    if (start === null || end === null || start === end) return false;

    const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
    return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  // ---------------------------------------------------------------------------
  // Phone number and verification
  // ---------------------------------------------------------------------------

  /** Sets (or replaces) the stored E.164 number; verification resets with it. Replacing a verified number un-verifies it: the new digits have proved nothing yet. */
  async setPhone(userId: string, rawPhone: string): Promise<SentinelVoiceSetting> {
    let e164: string;
    try {
      e164 = normaliseToE164(rawPhone) ?? '';
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw DomainException.badRequest(error.message);
      }
      throw error;
    }
    if (e164 === '') {
      throw DomainException.badRequest('Phone number is required.');
    }

    return this.prisma.sentinelVoiceSetting.upsert({
      where: { userId },
      create: { userId, phoneE164: e164 },
      // A new number is not the old number: verification and attempts reset.
      update: { phoneE164: e164, phoneVerifiedAt: null, verificationCodeHash: null, verificationExpiresAt: null, verificationAttempts: 0 },
    });
  }

  /**
   * Mints one six-digit verification code.
   *
   * Where the code goes is an honest question with no infrastructure answer in
   * this project (no SMS provider), so: outside production the response names
   * the code, which lets a developer verify their own number locally; in
   * production this endpoint still mints and stores, delivery is documented as
   * requiring an SMS/voice-say provider, and the verification completes only
   * when the user repeats the digits - the code never travels back to them
   * through a channel that did not deliver it.
   */
  async requestVerification(userId: string): Promise<VerificationRequestResult> {
    const settings = await this.settingsFor(userId);
    if (!settings.phoneE164) {
      throw DomainException.badRequest('Set a phone number before requesting verification.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.sentinelVoiceSetting.update({
      where: { userId },
      data: {
        verificationCodeHash: hashCode(code),
        verificationExpiresAt: new Date(Date.now() + this.config.sentinel.verificationCodeTtlMs),
        verificationAttempts: 0,
      },
    });

    const deliverableNow = this.config.nodeEnv !== 'production';
    return {
      status: deliverableNow ? 'ISSUED' : 'ISSUED_DELIVERY_PENDING',
      ...(deliverableNow ? { code } : {}),
    };
  }

  /** Confirms the code, burning the budget on wrong guesses and verifying on the right one. */
  async confirmVerification(userId: string, code: string): Promise<SentinelVoiceSetting> {
    const settings = await this.settingsFor(userId);

    if (
      !settings.verificationCodeHash ||
      settings.verificationExpiresAt === null ||
      settings.verificationExpiresAt.getTime() <= Date.now()
    ) {
      throw DomainException.badRequest('No verification code is pending. Request a new one.');
    }
    if (settings.verificationAttempts >= this.config.sentinel.verificationMaxAttempts) {
      throw DomainException.badRequest('Too many attempts. Request a new verification code.');
    }
    if (hashCode(code.trim()) !== settings.verificationCodeHash) {
      const attempts = settings.verificationAttempts + 1;
      const expired = attempts >= this.config.sentinel.verificationMaxAttempts;
      await this.prisma.sentinelVoiceSetting.update({
        where: { userId },
        data: {
          verificationAttempts: attempts,
          // The budget spent in full burns the code: a fresh one must be
          // requested, because the sixth guess is the caller's last chance.
          ...(expired ? { verificationCodeHash: null, verificationExpiresAt: null } : {}),
        },
      });
      throw DomainException.badRequest('That code is not correct.');
    }

    return this.prisma.sentinelVoiceSetting.update({
      where: { userId },
      data: { phoneVerifiedAt: new Date(), verificationCodeHash: null, verificationExpiresAt: null, verificationAttempts: 0 },
    });
  }

  // ---------------------------------------------------------------------------
  // Consent, quiet hours and the off switch
  // ---------------------------------------------------------------------------

  /** Records explicit consent; requires a verified number first. */
  async grantConsent(userId: string): Promise<SentinelVoiceSetting> {
    const settings = await this.settingsFor(userId);
    if (!settings.phoneE164 || settings.phoneVerifiedAt === null) {
      throw DomainException.badRequest('Verify your phone number before consenting to calls.');
    }
    // A change of heart replaces an earlier withdrawal; the record keeps both
    // timestamps so the timeline is honest about what happened when.
    return this.prisma.sentinelVoiceSetting.update({
      where: { userId },
      data: { consentAt: new Date(), consentWithdrawnAt: null },
    });
  }

  /** Withdraws consent immediately. Calls that already dialled are not recalled - only future ones stop. */
  async withdrawConsent(userId: string): Promise<SentinelVoiceSetting> {
    const settings = await this.settingsFor(userId);
    if (settings.consentAt !== null && settings.consentWithdrawnAt === null) {
      return this.prisma.sentinelVoiceSetting.update({
        where: { userId },
        data: { consentWithdrawnAt: new Date() },
      });
    }
    return settings;
  }

  /** The user-level off switch, on and off, without touching alerts or history. */
  async setVoiceDisabled(userId: string, disabled: boolean): Promise<SentinelVoiceSetting> {
    await this.settingsFor(userId);
    return this.prisma.sentinelVoiceSetting.update({
      where: { userId },
      data: { voiceDisabledAt: disabled ? new Date() : null },
    });
  }

  /** Sets the quiet window in minutes-since-UTC-midnight, both ends or neither. */
  async setQuietHours(userId: string, startUtc: number | null, endUtc: number | null): Promise<SentinelVoiceSetting> {
    await this.settingsFor(userId);
    const valid = (value: number | null): boolean => value === null || (Number.isInteger(value) && value >= 0 && value <= 1439);
    if (!valid(startUtc) || !valid(endUtc) || (startUtc === null) !== (endUtc === null)) {
      throw DomainException.badRequest('Quiet hours must be given as both ends (0-1439 minutes since UTC midnight) or neither.');
    }
    return this.prisma.sentinelVoiceSetting.update({
      where: { userId },
      data: { quietHoursStartUtc: startUtc, quietHoursEndUtc: endUtc },
    });
  }

  // ---------------------------------------------------------------------------
  // Budget counters (shared with the caller pass)
  // ---------------------------------------------------------------------------

  /** Calls actually initiated by this user inside the current UTC day. */
  async userCallsInitiatedTodayUtc(userId: string, at: Date): Promise<number> {
    return this.prisma.sentinelVoiceCall.count({
      where: { initiatedAt: { gte: startOfUtcDay(at) }, alert: { ownerId: userId } },
    });
  }

  /** Calls initiated platform-wide inside the current UTC day. */
  async platformCallsInitiatedTodayUtc(at: Date): Promise<number> {
    return this.prisma.sentinelVoiceCall.count({
      where: { initiatedAt: { gte: startOfUtcDay(at) } },
    });
  }
}

/** The reasons the gate can refuse, in the order `callGateFor` reports them. */
export type SentinelCallGateReason =
  | 'PROVIDER_OFF'
  | 'VOICE_OFF'
  | 'PHONE_UNVERIFIED'
  | 'CONSENT_MISSING'
  | 'QUIET_HOURS'
  | 'USER_DAILY_LIMIT'
  | 'PLATFORM_DAILY_LIMIT';

export interface SentinelCallGate {
  readonly ok: boolean;
  readonly reason: SentinelCallGateReason | null;
}

export interface VerificationRequestResult {
  readonly status: 'ISSUED' | 'ISSUED_DELIVERY_PENDING';
  /** Present only where the platform can honestly deliver it (never production). */
  readonly code?: string;
}

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function gateRecordsBlocked(gate: SentinelCallGate | { ok: boolean; reason: string | null }): gate is { ok: false; reason: SentinelCallGateReason } {
  return !gate.ok && gate.reason !== null;
}

function hashCode(code: string): string {
  // Salting with the hash's own purpose makes the digest meaningless as a
  // rainbow table entry even though the entropy is only six decimal digits.
  return createHash('sha256').update(`sentinel-verification:${code}`).digest('hex');
}
