import { Injectable } from '@nestjs/common';

import type {
  VoiceCallProvider,
  VoiceDialRequest,
  VoiceDialResult,
  VoiceWebhookInput,
  VoiceWebhookOutcome,
  VoiceWebhookParseResult,
} from './voice-call-provider.port';
import { VoiceCallProviderError } from './voice-call-provider.port';
import { verifyTwilioSignature } from './twilio-signature';

/** Twilio's current programmable-voice REST root. */
const TWILIO_API_ROOT = 'https://api.twilio.com/2010-04-01';

/** Hard ceiling on one dial attempt, so a hung provider cannot hold the caller pass. */
const DIAL_TIMEOUT_MS = 10_000;

/**
 * MODULE 14 - the real adapter, wired but never contacted by a test.
 *
 * HOW A REAL CALL WORKS THROUGH THIS MODULE:
 *  1. `dial` POSTs to the Twilio REST `Calls.json` resource with a TwiML
 *     `<Say>` of the exact spoken text - Basic auth with the account SID and
 *     auth token, both server-side env values.
 *  2. Twilio returns a call SID, which lands in `provider_call_id`.
 *  3. Twilio later POSTs a status callback to Sentinel's public webhook route;
 *     that request proves itself with the `X-Twilio-Signature` header, checked
 *     against the same auth token, before its contents are read.
 *
 * NO SDK. Twilio is two calls - one REST POST, one signature scheme - and the
 * adapter prefers `fetch` plus `node:crypto` over a dependency. Transport
 * failures surface as retryable errors; terminal provider refusals (bad
 * number, unverified caller id, exhausted account) surface as non-retryable.
 */
@Injectable()
export class TwilioVoiceCallProvider implements VoiceCallProvider {
  readonly mode = 'twilio' as const;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
  ) {
    // Off-behaviour candidates are refused at construction - this provider
    // exists only when all three credentials are present (it is also checked
    // at boot by the config, but a test could construct one directly).
    if (!accountSid || !authToken || !fromNumber) {
      throw new Error(
        'TwilioVoiceCallProvider requires an account SID, auth token and from-number.',
      );
    }
  }

  async dial(request: VoiceDialRequest): Promise<VoiceDialResult> {
    const body = new URLSearchParams({
      To: request.to,
      From: this.fromNumber,
      Twiml: `<Response><Say language="en-US">${escapeTwiMl(request.spokenText)}</Say></Response>`,
    });

    let response: Response;
    try {
      response = await fetch(
        `${TWILIO_API_ROOT}/Accounts/${encodeURIComponent(this.accountSid)}/Calls.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
        },
      );
    } catch (error) {
      // Network/timeout/abort: the next attempt may well succeed.
      throw new VoiceCallProviderError(
        'PROVIDER_UNREACHABLE',
        `Twilio dial failed: ${error instanceof Error ? error.name : 'transport error'}.`,
        true,
      );
    }

    if (response.ok) {
      const payload = (await response.json()) as { sid?: string };
      if (!payload.sid) {
        throw new VoiceCallProviderError('PROVIDER_MALFORMED', 'Twilio dial returned no call SID.', false);
      }
      return { providerCallId: payload.sid };
    }

    // A provider-declined request: 4xx will not get better by retrying the same
    // request; 5xx might.
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceCallProviderError(
      response.status >= 500 ? 'PROVIDER_ERROR' : 'PROVIDER_REFUSED',
      `Twilio dial answered ${response.status}.`,
      response.status >= 500,
    );
  }

  verifyAndParseWebhook(input: VoiceWebhookInput): VoiceWebhookParseResult {
    const provided = input.headers['x-twilio-signature'];

    if (!verifyTwilioSignature(this.authToken, input.url, input.params, provided)) {
      return { ok: false, reason: 'WEBHOOK_SIGNATURE_INVALID' };
    }

    const callSid = input.params['CallSid'];
    if (!callSid) {
      return { ok: false, reason: 'WEBHOOK_MISSING_CALL_ID' };
    }

    const outcome = mapTwilioStatus(input.params['CallStatus'] ?? '');
    if (outcome === null) {
      return { ok: false, reason: 'WEBHOOK_UNKNOWN_STATUS' };
    }

    return { ok: true, providerCallId: callSid, outcome };
  }
}

/** Twilio's documented CallStatus vocabulary, mapped onto ours. */
function mapTwilioStatus(callStatus: string): VoiceWebhookOutcome | null {
  switch (callStatus) {
    case 'queued':
    case 'ringing':
    case 'in-progress':
      // Progress events are idempotent no-ops for a row already dialled.
      return 'INITIATED';
    case 'completed':
      return 'COMPLETED';
    case 'busy':
      return 'BUSY';
    case 'failed':
      return 'FAILED';
    case 'no-answer':
      return 'NO_ANSWER';
    case 'canceled':
      return 'CANCELED';
    default:
      return null;
  }
}

function escapeTwiMl(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
