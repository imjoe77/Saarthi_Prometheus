import "server-only";

import { cookies } from "next/headers";

import { accessTokenTtlSeconds, mintAccessToken } from "@/lib/api-token";
import { auth, isAuthenticatedSession } from "@/lib/auth";

/**
 * MODULE 02 — the API access token cookie.
 *
 * Separate from the Auth.js session cookie on purpose, with a separate lifetime:
 *
 *  - The session lasts a week and says only "this browser authenticated
 *    previously". That is Auth.js's business.
 *  - The access token lasts minutes and says "this is the Prometheus identity to
 *    act as". That is the backend's business.
 *
 * Keeping them apart means logging out can invalidate the browser's access
 * immediately, and it keeps the token handed to the backend as short-lived as
 * the token needs to be.
 *
 * `httpOnly` is the load-bearing attribute. With it, no script in the page can
 * read the token, so an XSS bug cannot exfiltrate a credential. `secure` in
 * production, `sameSite: "lax"` so it survives a top-level navigation back from
 * an OAuth provider, and `path: "/"` because the BFF proxy is not confined to one
 * subdirectory.
 */
export const ACCESS_TOKEN_COOKIE = "prometheus_api_token";

const baseCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;

export async function setAccessTokenCookie(token: string): Promise<void> {
  const store = await cookies();

  store.set(ACCESS_TOKEN_COOKIE, token, { ...baseCookieOptions, maxAge: accessTokenTtlSeconds() });
}

/**
 * Removes the access token cookie.
 *
 * `maxAge: 0` with an empty value: deleting alone can leave a browser that has
 * not yet expired the original cookie holding it until it does.
 */
export async function clearAccessTokenCookie(): Promise<void> {
  const store = await cookies();

  store.set(ACCESS_TOKEN_COOKIE, "", { ...baseCookieOptions, maxAge: 0 });
}

export async function readAccessTokenCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(ACCESS_TOKEN_COOKIE)?.value;
}

/**
 * Issues an access token if the caller has a session but no live token.
 *
 * Called from the BFF on every proxied request. Minting per request rather than
 * at sign-in means the token is always fresh and always reflects the *current*
 * session: if the user logged out and back in as somebody else, the next API call
 * produces a token for the new identity instead of replaying the old one.
 *
 * Returns `null` when there is no session. That is the only signal the caller
 * needs, and it deliberately carries no detail about *why*.
 */
export async function ensureAccessToken(): Promise<string | null> {
  const session = await auth();

  if (!isAuthenticatedSession(session)) {
    return null;
  }

  const token = await mintAccessToken({
    externalIdentity: session.externalIdentity,
    // The backend needs the address to provision a first-login user. It is never
    // used to match or merge an existing one.
    email: session.user?.email ?? "",
    // The persona picked at sign-in, if any. Minted fresh per request, so a
    // session re-picked at the login screen changes the effective roles on the
    // very next API call with no token to revoke.
    loginRole: session.loginRole,
  });

  await setAccessTokenCookie(token);

  return token;
}