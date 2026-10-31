import { errors, importSPKI, jwtVerify, type JWTPayload, type KeyLike } from 'jose';
import { Role } from '@prisma/client';

import type { AuthConfig } from '../../config/app.config';

/**
 * Roles a session may declare as its "active" (login-intent) role.
 *
 * PLATFORM_ADMIN is a persona like the others: the login page's Platform Admin
 * card signs in with `loginRole=PLATFORM_ADMIN` so the session is scoped to the
 * admin surface alone. The claim can only ever *narrow* — whether it applies is
 * decided in {@link AuthService} by intersecting it with the roles the database
 * actually holds, so carrying it grants nothing by itself.
 */
const PERSONA_ROLES: readonly string[] = [
  Role.USER,
  Role.EXPERT_TRADER,
  Role.LIQUIDITY_PROVIDER,
  Role.PLATFORM_ADMIN,
];

/** Injection token so tests can supply a verifier without booting the app. */
export const AUTH_TOKEN_VERIFIER = Symbol('AUTH_TOKEN_VERIFIER');

/**
 * A Prometheus identity proven by a verified access token.
 *
 * Deliberately small. `externalIdentity` is the Auth.js subject
 * (`provider:providerAccountId`); it is the join key against `auth_accounts`,
 * never an authority in itself. The Prometheus `User.id` is resolved separately
 * in {@link AuthService}, because a valid signature only proves the token was
 * issued by the frontend - it says nothing about which user it refers to.
 */
export interface VerifiedIdentity {
  /** `provider:providerAccountId`, e.g. `google:109876543210`. */
  readonly externalIdentity: string;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly email: string | null;
  /**
   * The role this session signed in *as* (MODULE 13 login intent), or `null`
   * when the token carries no such claim — which is every token minted before
   * the concept existed, and every token for a session that picked no persona.
   *
   * Parsed leniently: a claim naming anything but a persona role (garbage, an
   * admin attempt) is treated as absent rather than failing the token, because
   * the claim's only power is to narrow an identity the signature already
   * proved. Ignoring an unrecognised value degrades to the pre-existing
   * "all held roles" behaviour; it can never widen it.
   */
  readonly loginRole: Role | null;
}

export interface TokenVerifier {
  /** Resolves to the identity, or throws {@link InvalidAccessTokenError}. */
  verify(token: string): Promise<VerifiedIdentity>;
}

/**
 * Why a token was refused.
 *
 * The distinction is for logs and tests only. Every one of these produces the
 * same 401 with the same message to the client: telling a caller *why* a token
 * failed is free reconnaissance.
 */
export type TokenFailureReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'unsupported_algorithm'
  | 'invalid_claims';

export class InvalidAccessTokenError extends Error {
  constructor(readonly reason: TokenFailureReason) {
    super(`Access token rejected: ${reason}`);
    this.name = 'InvalidAccessTokenError';
  }
}

/**
 * RS256-only verifier for access tokens minted by the Next.js server.
 *
 * Everything this class trusts, it trusted by *computing*: the signature over
 * the public key, and the `iss`/`aud`/`exp` claims. It never trusts a header,
 * a request body, or any identifier the caller supplied.
 *
 * Why the algorithm is pinned rather than read from the token: an unpinned
 * verifier can be walked down to `alg: none` or handed an HMAC key that gets
 * verified as if it were the public key. `algorithms: ['RS256']` makes both
 * structurally impossible.
 */
export class AccessTokenVerifier implements TokenVerifier {
  private readonly publicKeyPem: string;
  private readonly issuer: string;
  private readonly audience: string;

  /**
   * Cached import of the PEM.
   *
   * `importSPKI` is async because it goes through WebCrypto, so the promise is
   * memoised: one key parse per process rather than one per request. Caching a
   * rejected promise too is deliberate - a broken key should keep failing the
   * same way instead of retrying the parse on every call.
   */
  private keyPromise: Promise<KeyLike | null> | null = null;

  constructor(config: AuthConfig) {
    this.publicKeyPem = config.publicKey;
    this.issuer = config.issuer;
    this.audience = config.audience;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const key = await this.resolveKey();

    if (!key) {
      // Misconfiguration, not a client error. Fail closed rather than treating
      // every request as merely unauthenticated.
      throw new InvalidAccessTokenError('malformed');
    }

    if (typeof token !== 'string' || token.length === 0) {
      throw new InvalidAccessTokenError('malformed');
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
        typ: 'JWT',
      });
      payload = verified.payload;
    } catch (error) {
      throw new InvalidAccessTokenError(classify(error));
    }

    return this.toIdentity(payload);
  }

  private resolveKey(): Promise<KeyLike | null> {
    this.keyPromise ??= this.publicKeyPem
      ? importSPKI(this.publicKeyPem, 'RS256').catch(() => null)
      : Promise.resolve(null);

    return this.keyPromise;
  }

  /**
   * Validates the claims the backend actually depends on.
   *
   * `iss`, `aud`, `exp` and the signature are already guaranteed by
   * `jwtVerify`. What remains is the identity binding: an `sub` we can join on,
   * and a provider we recognise.
   */
  private toIdentity(payload: JWTPayload): VerifiedIdentity {
    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';

    if (!sub) {
      throw new InvalidAccessTokenError('invalid_claims');
    }

    // `sub` is defined by the signer as `provider:providerAccountId`. Parse it
    // rather than trusting a parallel claim that could disagree with it.
    const separator = sub.indexOf(':');
    if (separator <= 0 || separator === sub.length - 1) {
      throw new InvalidAccessTokenError('invalid_claims');
    }

    const provider = sub.slice(0, separator).trim().toLowerCase();
    const providerAccountId = sub.slice(separator + 1).trim();

    if (!providerAccountId) {
      throw new InvalidAccessTokenError('invalid_claims');
    }

    // `jwtVerify` validates `exp` when present but does not insist on it, so an
    // unsigned-by-omission token without an expiry would verify and never lapse.
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new InvalidAccessTokenError('invalid_claims');
    }

    const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : null;

    return {
      externalIdentity: sub,
      provider,
      providerAccountId,
      email,
      loginRole: parseLoginRole(payload.loginRole),
    };
  }
}

/**
 * Narrows the optional `loginRole` claim to a persona role, or `null`.
 *
 * Anything that is not exactly one of USER / EXPERT_TRADER / LIQUIDITY_PROVIDER /
 * PLATFORM_ADMIN reads as "no active role", so the caller keeps every held
 * role. This is the same leniency the email claim gets, and for the same
 * reason: the claim refines an identity the signature already proved, so a
 * bogus value must not be able to break the token, only fail to narrow it.
 * Even a genuine PLATFORM_ADMIN claim only ever *narrows* — {@link AuthService}
 * intersects it with the roles the database holds, so it can never widen a
 * session into admin.
 */
function parseLoginRole(value: unknown): Role | null {
  return typeof value === 'string' && PERSONA_ROLES.includes(value) ? (value as Role) : null;
}

/**
 * Maps a jose error onto a reason code without leaking its message.
 *
 * `jose` messages describe exactly which check failed ("iss 'x' not allowed"),
 * which is useful in a log and dangerous in a response body. Keeping the mapping
 * here means no call site has to touch the raw error.
 */
function classify(error: unknown): TokenFailureReason {
  if (!(error instanceof errors.JOSEError)) {
    return 'malformed';
  }

  switch (error.code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return classifyClaimFailure(error);
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'bad_signature';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
    case 'ERR_JOSE_GENERIC':
      return classifyJwsError(error);
    default:
      return 'malformed';
  }
}

function classifyClaimFailure(error: errors.JOSEError): TokenFailureReason {
  // `claim`/`reason` only exist on claim-validation errors, so they are read
  // defensively off the structural type.
  const detail = error as errors.JOSEError & { claim?: unknown; reason?: unknown };
  const claim = typeof detail.claim === 'string' ? detail.claim : '';
  const reason = typeof detail.reason === 'string' ? detail.reason : '';

  if (claim === 'iss') return 'wrong_issuer';
  if (claim === 'aud') return 'wrong_audience';
  if (claim === 'exp') return 'expired';
  if (claim === 'nbf') return 'not_yet_valid';
  if (reason.includes('iss')) return 'wrong_issuer';
  if (reason.includes('aud')) return 'wrong_audience';
  if (reason.includes('exp')) return 'expired';
  if (reason.includes('nbf')) return 'not_yet_valid';

  return 'invalid_claims';
}

function classifyJwsError(error: errors.JOSEError): TokenFailureReason {
  const message = error.message.toLowerCase();
  if (message.includes('signature')) return 'bad_signature';
  if (message.includes('alg')) return 'unsupported_algorithm';
  return 'malformed';
}