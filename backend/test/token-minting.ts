import { importPKCS8, SignJWT } from 'jose';

import {
  InvalidAccessTokenError,
  type TokenFailureReason,
} from '../src/modules/auth/token-verifier.service';
import { TEST_PRIVATE_KEY, UNTRUSTED_KEYPAIR } from './auth-test-keys';

const ISSUER = 'prometheus-web';
const AUDIENCE = 'prometheus-api';

/**
 * Keys are imported through jose rather than passed as raw bytes, because
 * RS256 keys are asymmetric: a byte array would be an HMAC secret, and signing a
 * token that way would not exercise the verification path under test.
 */
const privateKeyPromise = importPKCS8(TEST_PRIVATE_KEY, 'RS256');
const untrustedPrivateKeyPromise = importPKCS8(UNTRUSTED_KEYPAIR.privateKey, 'RS256');

interface TokenOverrides {
  subject?: string;
  /** `null` omits the claim entirely. */
  issuer?: string | null;
  /** `null` omits the claim entirely. */
  audience?: string | string[] | null;
  /** `null` omits the claim entirely. */
  expiresIn?: string | number | null;
  notBefore?: string;
  email?: string;
  algorithm?: string;
  /** Signs with an unrelated key, producing a token we must refuse. */
  untrustedKey?: boolean;
  /**
   * Signs with the public key treated as an HMAC secret. Exercises the
   * algorithm-confusion defence; jose refuses to sign RS256 this way, so the
   * caller builds the token itself.
   */
  keyAsHmacSecret?: boolean;
  extraClaims?: Record<string, unknown>;
}

/**
 * Mints a token exactly the way the Next.js server is expected to.
 *
 * The defaults are the production contract: RS256, our issuer, our audience, a
 * 15 minute lifetime. Tests vary one field at a time so a failure points at the
 * single check that stopped it.
 */
export async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  const {
    subject = 'google:109876543210',
    issuer = ISSUER,
    audience = AUDIENCE,
    expiresIn = '15m',
    notBefore,
    email = 'user@example.com',
    algorithm = 'RS256',
    untrustedKey = false,
    extraClaims = {},
  } = overrides;

  const builder0 = new SignJWT({ email, ...extraClaims })
    // `typ` is part of the contract, not decoration: the verifier pins it so a
    // token minted for a different purpose cannot be replayed here.
    .setProtectedHeader({ alg: algorithm, typ: 'JWT' })
    .setSubject(subject)
    .setIssuedAt();

  let builder = builder0;
  if (issuer !== null) builder = builder.setIssuer(issuer);
  if (audience !== null) builder = builder.setAudience(audience);
  if (expiresIn !== null) builder = builder.setExpirationTime(expiresIn);
  if (notBefore) builder = builder.setNotBefore(notBefore);

  const key = untrustedKey ? await untrustedPrivateKeyPromise : await privateKeyPromise;

  return builder.sign(key);
}

/**
 * Builds an HS256 token whose "secret" is the public key.
 *
 * Hand-built because jose (correctly) refuses to sign with an asymmetric key.
 * The point of the test is that our verifier refuses the result even though the
 * attacker holds every byte needed to produce a valid-looking signature.
 */
export async function mintAlgorithmConfusionToken(subject = 'google:12345'): Promise<string> {
  const publicKey = process.env['AUTH_API_SIGNING_PUBLIC_KEY'] ?? '';

  if (!publicKey) {
    throw new Error('Cannot build an algorithm-confusion token without a readable public key.');
  }

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(publicKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return new SignJWT({ email: 'attacker@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(hmacKey);
}

/** A token with an `alg: none` header and no signature at all. */
export function mintUnsignedToken(subject = 'google:12345'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      email: 'attacker@example.com',
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 900,
    }),
  ).toString('base64url');

  return `${header}.${payload}.`;
}

/**
 * Asserts that verifying `token` is refused, and hands the reason back.
 *
 * Takes the token rather than a thunk so call sites can mint first, which keeps
 * `await` out of a non-async arrow and makes each assertion read as one step.
 */
export async function expectRejection(
  verify: (token: string) => Promise<unknown>,
  token: string,
  expected: TokenFailureReason,
): Promise<InvalidAccessTokenError> {
  try {
    await verify(token);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidAccessTokenError);
    const reason = (error as InvalidAccessTokenError).reason;
    expect(reason).toBe(expected);
    return error as InvalidAccessTokenError;
  }

  throw new Error(`Expected the token to be rejected with reason "${expected}", but it verified.`);
}