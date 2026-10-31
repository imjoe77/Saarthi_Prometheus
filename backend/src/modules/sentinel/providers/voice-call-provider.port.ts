/**
 * MODULE 14 - the boundary between Sentinel and anything that can dial a
 * phone, and the token by which the implementation is supplied.
 *
 * ONE DIAL, ONE WEBHOOK. `dial` places a call that speaks exactly the text it
 * is given; `verifyAndParseWebhook` is how the provider tells Sentinel what
 * happened afterwards. Nothing else belongs to this port - consent checks,
 * limits, retries and the lifecycle state machine all live in the service.
 *
 * ERROR SHAPE. A dial that cannot happen (network refused, provider rejected)
 * throws {@link VoiceCallProviderError}. Expected call outcomes (busy,
 * no-answer) are NOT errors - they are webhook events, and arrive through the
 * webhook path like any completion.
 */
export const VOICE_CALL_PROVIDER = Symbol('VOICE_CALL_PROVIDER');

export type VoiceCallProviderMode = 'off' | 'fake' | 'twilio';

/** Everything needed to place one call. `to` is canonical E.164. */
export interface VoiceDialRequest {
  readonly to: string;
  /** The exact text to speak. Never contains health data, balances or secrets. */
  readonly spokenText: string;
}

export interface VoiceDialResult {
  /** Non-null when the provider accepted the call and returned a reference. */
  readonly providerCallId: string;
}

/**
 * A dial attempt that did not result in an initiated call.
 *
 * `retryable` distinguishes "try again after the delay" (provider hiccup,
 * 5xx, network) from "the same attempt will fail identically" (misconfiguration,
 * refused number, exhausted provider balance). The caller service turns
 * `retryable: false` into an immediate CALL_FAILED and `retryable: true` into
 * the retry schedule - and either way the attempt is counted.
 */
export class VoiceCallProviderError extends Error {
  readonly failReason: string;
  readonly retryable: boolean;

  constructor(failReason: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'VoiceCallProviderError';
    this.failReason = failReason;
    this.retryable = retryable;
  }
}

export type VoiceWebhookOutcome =
  | 'INITIATED'
  | 'COMPLETED'
  | 'BUSY'
  | 'NO_ANSWER'
  | 'REJECTED'
  | 'CANCELED'
  | 'FAILED';

export type VoiceWebhookParseResult =
  | { readonly ok: true; readonly providerCallId: string; readonly outcome: VoiceWebhookOutcome }
  | { readonly ok: false; readonly reason: string };

export interface VoiceCallProvider {
  /** Which implementation this is. Never changes for one instance. */
  readonly mode: VoiceCallProviderMode;

  /**
   * Places one call. Resolves with the provider's call reference, or throws
   * {@link VoiceCallProviderError}. Never resolves-successfully-without-actually-
   * asking-the-provider-to-dial.
   */
  dial(request: VoiceDialRequest): Promise<VoiceDialResult>;

  /**
   * Decides whether an inbound status callback really came from this provider,
   * and what it says. A request that fails verification is refused here - the
   * service never even sees the event.
   */
  verifyAndParseWebhook(input: VoiceWebhookInput): VoiceWebhookParseResult;
}

export interface VoiceWebhookInput {
  readonly url: string;
  /** Request headers, lower-cased keys. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Parsed application/x-www-form-urlencoded parameters (string values). */
  readonly params: Readonly<Record<string, string>>;
}
