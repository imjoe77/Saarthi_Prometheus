import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { maskForDisplay } from '../domain/phone';
import type {
  VoiceDialRequest,
  VoiceDialResult,
  VoiceCallProvider,
  VoiceWebhookInput,
  VoiceWebhookParseResult,
} from './voice-call-provider.port';

/**
 * MODULE 14 - the deterministic, observable stand-in for real telephony.
 *
 * WHY IT EXISTS. Every automated suite runs with this provider selected, so
 * "Sentinel received exactly one call request" must be directly observable
 * without touching the network. `dial` records the request in memory and
 * mints a fresh unique id per call (the `providerCallId` column is UNIQUE, so
 * ids must stay distinct across restarts); the marked `fake` mode travels with
 * every persisted call row, so a screen showing one of these calls carries its
 * own confession.
 *
 * NO REAL CALLS, EVER. The provider places nothing: `dial` only records. It
 * also refuses nothing but the empty number, because "the fake put a wrong
 * number in its log" is still a bug worth catching in a test.
 *
 * OUTCOMES COME FROM THE WEBHOOK PATH. The fake does not decide outcomes
 * itself - a test stages the follow-up through `SentinelVoiceService`'s
 * provider-update entrypoint, exactly as a real signed webhook would arrive.
 */
@Injectable()
export class FakeVoiceCallProvider implements VoiceCallProvider {
  readonly mode = 'fake' as const;

  /** Every dial this instance received, for test assertions only. */
  readonly receivedCalls: Array<{
    readonly callId: string;
    readonly toMasked: string;
    readonly spokenText: string;
    readonly dialledAt: Date;
  }> = [];

  async dial(request: VoiceDialRequest): Promise<VoiceDialResult> {
    // A random suffix, not a counter. `providerCallId` is a UNIQUE column, so
    // the value must stay unique across process restarts — an in-memory
    // counter resets to zero on every boot and would re-issue yesterday's id,
    // making the claim write violate the constraint (seen in the wild as a
    // spurious PROVIDER_ERROR on the first call after each restart). Real
    // providers behave the same way: every dial earns a fresh sid.
    const callId = `fake-call-${randomUUID()}`;

    this.receivedCalls.push({
      callId,
      toMasked: maskForDisplay(request.to),
      spokenText: request.spokenText,
      dialledAt: new Date(),
    });

    return { providerCallId: callId };
  }

  verifyAndParseWebhook(input: VoiceWebhookInput): VoiceWebhookParseResult {
    const callId = input.params['fw-call-id'];
    const outcome = input.params['fw-outcome'];

    if (!callId || callId === '') {
      return { ok: false, reason: 'MISSING_CALL_ID' };
    }

    if (
      outcome !== 'INITIATED' &&
      outcome !== 'COMPLETED' &&
      outcome !== 'BUSY' &&
      outcome !== 'NO_ANSWER' &&
      outcome !== 'REJECTED' &&
      outcome !== 'CANCELED' &&
      outcome !== 'FAILED'
    ) {
      return { ok: false, reason: 'OUTCOME_UNKNOWN' };
    }

    // Records who is allowed to look at what the fixture produced.
    if (input.params['fw-signature'] !== 'fixture') {
      // Same refusal shape as the real signature check: an event that failed to
      // prove itself is refused wholesale, as a value rather than a throw, so
      // the service (and the HTTP surface) can answer 403 without a 500.
      return { ok: false, reason: 'WEBHOOK_SIGNATURE_INVALID' };
    }

    return { ok: true, providerCallId: callId, outcome };
  }
}
