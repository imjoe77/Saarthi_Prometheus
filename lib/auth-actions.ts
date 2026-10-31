"use server";

import { clearAccessTokenCookie } from "@/lib/access-token-cookie";
import { signIn } from "@/lib/auth";

/**
 * MODULE 02 — sign-in, and the server half of sign-out.
 *
 * Sign-in is a Server Action rather than a client call because it needs the
 * session cookie and the signing key, and it may not happen where a script in the
 * page can observe it. A `signIn("google")` from the client would be a request
 * any page could forge; here the provider list is a closed set chosen on the
 * server.
 *
 * Sign-out itself runs on the client (`next-auth/react`, in AuthControls): a
 * Server Action clears the cookies but leaves the already-mounted SessionProvider
 * holding the previous session, so the header only updates after a reload. The
 * action below does the one part the browser cannot do — deleting the HttpOnly
 * API token cookie.
 */

/**
 * Starts the OAuth flow for one provider.
 *
 * `redirectTo` is a relative path on purpose. An absolute URL here would be an
 * open redirect: an attacker could send a user through a real sign-in and land
 * them on a page of their choosing with the session established.
 */
export async function signInWithProvider(
  provider: "google" | "github",
  redirectTo: string,
): Promise<void> {
  await signIn(provider, { redirectTo: safeRelativePath(redirectTo) });
}

/**
 * Clears the API access-token cookie.
 *
 * Called by the client immediately before `signOut()`. The token cookie is
 * HttpOnly, so this is the only layer that can delete it. Auth.js's own session
 * cookie is still the authority on the session: once `signOut()` removes it there
 * is nothing to mint a token from, so clearing this merely retires the existing
 * token a little earlier.
 *
 * A token copied out of the browser before logout stays valid until its short
 * expiry. Revoking that would need a denylist the backend can consult, which is
 * explicitly out of scope for this module; the short lifetime is the mitigation.
 */
export async function clearApiToken(): Promise<void> {
  await clearAccessTokenCookie();
}

/**
 * Constrains a redirect target to a path inside this application.
 *
 * Guards against `//evil.example.com` and `/\evil.example.com`, both of which
 * browsers treat as absolute URLs despite looking relative.
 */
function safeRelativePath(candidate: string): string {
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return "/";
  }

  return candidate;
}