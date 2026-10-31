import { createHmac } from 'node:crypto';

import { verifyTwilioSignature } from './twilio-signature';

/**
 * MODULE 14 - the one public, unauthenticated doorway Sentinel has.
 *
 * The properties worth pinning: a genuinely signed request passes; the same
 * request with one parameter reordered, added or tampered fails; an empty or
 * absent token refuses everything; and the verifier never throws - a malformed
 * URL is a refusal, not a 500.
 */
describe('twilio webhook signature verification', () => {
  const authToken = 'test-auth-token';
  const url = 'https://api.example.com/api/sentinel/voice/webhook';
  const params: Record<string, string> = {
    CallSid: 'CA123',
    CallStatus: 'completed',
  };

  function signatureFor(token: string, dataUrl = url, dataParams = params): string {
    const data =
      Object.keys(dataParams)
        .sort()
        .map((key) => `${key}${dataParams[key]}`)
        .reduce((accum, part) => accum + part, dataUrl);
    return createHmac('sha1', token).update(data).digest('base64');
  }

  it('accepts a validly signed request', () => {
    expect(verifyTwilioSignature(authToken, url, params, signatureFor(authToken))).toBe(true);
  });

  it('round-trips a signature the way a proxy may reshape the URL', () => {
    // Same canonical URL after port-normalisation.
    const proxied = 'https://api.example.com:443/api/sentinel/voice/webhook';
    expect(verifyTwilioSignature(authToken, proxied, params, signatureFor(authToken))).toBe(true);
  });

  it('refuses a tampered parameter', () => {
    const tampered = { ...params, CallStatus: 'failed' };
    expect(verifyTwilioSignature(authToken, url, tampered, signatureFor(authToken))).toBe(false);
  });

  it('refuses when a parameter is swapped in or out', () => {
    const extra = { ...params, ExtraParam: 'x' };
    expect(verifyTwilioSignature(authToken, url, params, signatureFor(authToken, url, extra))).toBe(false);
  });

  it('refuses a signature minted with a different token', () => {
    expect(verifyTwilioSignature('other-token', url, params, signatureFor(authToken))).toBe(false);
  });

  it('refuses an absent or empty header, and an empty auth token', () => {
    expect(verifyTwilioSignature(authToken, url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(authToken, url, params, '')).toBe(false);
    expect(verifyTwilioSignature('', url, params, signatureFor(authToken))).toBe(false);
  });

  it('refuses a malformed URL without throwing', () => {
    expect(verifyTwilioSignature(authToken, '::not a url::', params, signatureFor(authToken))).toBe(false);
  });
});
