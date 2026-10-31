import "server-only";

import { importPKCS8, SignJWT, type CryptoKey } from "jose";

import {
  getTokenAudience,
  getTokenIssuer,
  getTokenSigningKey,
  getTokenTtlSeconds,
} from "@/lib/auth-env";

/**
 * MODULE 02 — minting the access token the backend verifies.
 *
 * The token is signed here with RS256 and lives only in an HttpOnly cookie, so
 * no script running in the browser can read it. That is the whole point of the
 * BFF arrangement: the browser proves who the user is to the Next.js server,
 * and the Next.js server proves it to the backend. Nothing crosses the boundary
 * twice, and no credential is ever handed to client-side JavaScript.
 *
 * Claims, and why each one exists:
 *
 *  - `sub` = `provider:providerAccountId`. The backend joins on this and nothing
 *    else. It is deliberately not an email: two providers number their users
 *    independently, and matching on email would let a weaker-verified identity
 *    claim a stronger one.
 *  - `loginRole` = the persona this session signed in as (MODULE 13). It can
 *    only ever *narrow* the roles the backend reloads from the database, so it
 *    is safe to carry: a stale or wrong value makes the session act as fewer
 *    roles, never as more. Absent for a session that picked no persona.
 *  - `iss` / `aud`. A token minted for some other service in the same
 *    organisation must not be accepted here.
 *  - `iat` / `exp`. Short life, because there is no revocation list: the only
 *    way to make a leaked token useless sooner is for it to be useless soon.
 */
export interface AccessTokenInput {
  externalIdentity: string;
  email: string;
  /**
   * The role the user chose at sign-in, when they chose one. The type lists
   * the four login personas (MODULE 13); the claim stays narrowing-only on
   * the backend — it is intersected with the roles the database holds, so
   * carrying PLATFORM_ADMIN claims nothing an account does not already have.
   */
  loginRole?: "USER" | "EXPERT_TRADER" | "LIQUIDITY_PROVIDER" | "PLATFORM_ADMIN" | null;
}

let cachedKey: Promise<CryptoKey> | null = null;

/**
 * Imports the signing key once per process.
 *
 * `importPKCS8` is async and WebCrypto-backed, so re-importing per request would
 * mean a key parse on every API call. Memoised deliberately; the cache is cleared
 * on failure so a transient error is retryable, but a wrong key will keep
 * failing identically rather than appearing to work.
 */
async function getSigningKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = importPKCS8(getTokenSigningKey(), "RS256").catch((error: unknown) => {
      cachedKey = null;
      throw error;
    });
  }

  return cachedKey;
}

/** Mints a short-lived RS256 access token for one identity. */
export async function mintAccessToken(input: AccessTokenInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // The claim is only set when a persona was chosen; an unscoped session
  // simply omits it and the backend falls back to every held role.
  const payload: Record<string, string> = { email: input.email };
  if (input.loginRole) {
    payload["loginRole"] = input.loginRole;
  }

  return new SignJWT(payload)
    // `typ` is pinned on both sides: a token minted for another purpose should
    // not be replayable here even if it carries a valid signature.
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(input.externalIdentity)
    .setIssuer(getTokenIssuer())
    .setAudience(getTokenAudience())
    .setIssuedAt(now)
    .setExpirationTime(now + getTokenTtlSeconds())
    .sign(await getSigningKey());
}

/** Access token lifetime, used to set the cookie's own expiry. */
export function accessTokenTtlSeconds(): number {
  return getTokenTtlSeconds();
}