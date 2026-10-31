import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * MODULE 14 - Twilio's request signature, on node:crypto.
 *
 * THE PROVIDERS DOCUMENTED ALGORITHM, NOT A MADE-UP ONE: HMAC-SHA1 over the
 * full request URL followed by every POST parameter sorted alphabetically as
 * `key=value`, keyed by the account's auth token, base64-encoded, compared
 * against the `X-Twilio-Signature` header. Anything else an inbound request
 * carries is decoration; only a genuine Twilio account knows the token.
 *
 * CONSTANT-TIME. `timingSafeEqual` on equal-length buffers, so a wrong guess
 * about one character reveals nothing about the rest. Buffers of unequal
 * length compare false directly, which is also constant time.
 *
 * THE TOKEN IS REQUIRED. A deployment without TWILIO_AUTH_TOKEN cannot verify
 * anything, so `verifyTwilioSignature` answers false - the webhook route turns
 * that into a refusal rather than trusting an unverifiable public callback.
 */
const TWILIO_PORT_BY_SCHEME: Record<string, string> = { 'https:': '443', 'http:': '80' };

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  providedSignature: string | undefined,
): boolean {
  if (authToken === '' || !providedSignature || providedSignature === '') {
    return false;
  }

  // Normalise the scheme/host the way the provider's own examples do, so the
  // proxy's internal host name cannot break the signature.
  let canonicalUrl = url;
  try {
    const parsed = new URL(url);
    const port = parsed.port !== '' && parsed.port !== TWILIO_PORT_BY_SCHEME[parsed.protocol]
      ? `:${parsed.port}`
      : '';
    canonicalUrl = `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }

  const data = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .reduce((accum, part) => accum + part, canonicalUrl);

  const expected = createHmac('sha1', authToken).update(data).digest('base64');

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(providedSignature);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
