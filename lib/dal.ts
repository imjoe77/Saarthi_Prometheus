import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { auth, isAuthenticatedSession } from "@/lib/auth";

/**
 * MODULE 02 — the data access layer for identity.
 *
 * Every page, server action and route handler that acts on behalf of a person
 * goes through here, rather than reading the session cookie itself. That
 * centralisation is the point: an authorisation check that is one `auth()` call
 * away from being forgotten is an authorisation check that will be forgotten.
 *
 * Two rules this file exists to enforce:
 *
 *  1. A session proves who the person authenticated as *at a provider*. It does
 *     not say which Prometheus user they are. That mapping lives in the backend,
 *     and only the backend may make it.
 *  2. The browser never supplies a user id. Nothing here accepts one as input,
 *     which is what makes it impossible for a caller to ask "act as this other
 *     user".
 */

/**
 * Reads the current session, or `null`.
 *
 * Wrapped in `cache` so a render pass that checks the session in a layout and
 * again in a page reads the cookie once.
 */
export const getSession = cache(async () => {
  const session = await auth();
  return isAuthenticatedSession(session) ? session : null;
});

/**
 * Reads the current session, redirecting to sign-in when there is none.
 *
 * This is an *optimistic* check on the frontend: it keeps unauthenticated users
 * out of pages and out of navigation. It is not the security boundary. The
 * boundary is the backend, which verifies the access token independently and
 * refuses to act without one - so a page rendered here is a convenience, and
 * every piece of real data is still gated on the other side.
 */
export const requireSession = cache(async () => {
  const session = await getSession();

  if (!session) {
    // MODULE 02/13: forward to the dedicated login page — the same front door
    // proxy.ts uses. No destination is carried here because a server render
    // has no pathname of its own; proxy.ts passes `next` for the navigations
    // it sees.
    redirect("/login");
  }

  return session;
});

/**
 * The provider identity backing this session.
 *
 * The value the backend joins against `auth_accounts`, in `provider:id` form.
 * Useful for display and for correlating logs; never a substitute for the
 * Prometheus user id, which the backend resolves and returns.
 */
export const getExternalIdentity = cache(async () => {
  const session = await requireSession();
  return session.externalIdentity;
});