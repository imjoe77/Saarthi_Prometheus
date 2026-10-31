import { Injectable } from '@nestjs/common';

import type {
  VoiceDialRequest,
  VoiceDialResult,
  VoiceCallProvider,
  VoiceWebhookInput,
  VoiceWebhookParseResult,
} from './voice-call-provider.port';
import { VoiceCallProviderError } from './voice-call-provider.port';

/**
 * MODULE 14 - the provider that refuses to be one.
 *
 * THE ONLY SAFE DEFAULT. With no credentials and no configuration, Sentinel
 * still boots, still monitors prices, still triggers alerts and still records
 * call jobs: dial simply refuses, every time, with the honest reason, and the
 * alert ends CALL_FAILED/VOICE_PROVIDER_DISABLED instead of pretending a call
 * happened. An operator who wants real telephony selects it explicitly.
 */
@Injectable()
export class OffVoiceCallProvider implements VoiceCallProvider {
  readonly mode = 'off' as const;

  // A missing implementation is a configuration fact, not a transient fault:
  // the same attempt would fail identically forever, so it is NOT retryable.
  dial(request: VoiceDialRequest): Promise<VoiceDialResult> {
    return Promise.reject(
      new VoiceCallProviderError(
        'VOICE_PROVIDER_DISABLED',
        'Voice calling is disabled (SENTINEL_VOICE_PROVIDER=off). Configure a provider to enable calls.',
        false,
      ),
    );
  }

  // The off provider receives no webhooks and can verify none.
  verifyAndParseWebhook(_input: VoiceWebhookInput): VoiceWebhookParseResult {
    return { ok: false, reason: 'VOICE_PROVIDER_DISABLED' };
  }
}
