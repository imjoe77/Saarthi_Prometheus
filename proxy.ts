import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { isProtectedPath } from "@/lib/protected-paths";

/**
 * MODULE 02 — optimistic route protection.
 *
 * Reads the session cookie and redirects signed-out visitors away from
 * protected pages, so they never render a shell full of empty panels before the
 * DAL sends them to sign-in.
 *
 * Optimistic is the operative word, and it is deliberately not the whole defence:
 *
 *  - This reads only the signed session cookie. It performs no I/O and consults
 *    no database, because this runs on *every* request including prefetches, and
 *    a check that costs a query per prefetch is a check that will be skipped.
 *  - It can therefore be fooled by a stale cookie. It is a routing convenience.
 *  - The actual enforcement is in the DAL next to the data, and behind that, in
 *    the backend, which verifies the access token on its own and refuses every
 *    request that lacks a valid one. Nothing rendered here depends on this file
 *    being correct.
 *
 * Not run for API routes: those answer with JSON and are gated by the BFF, which
 * has a session requirement of its own.
 */
export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isProtectedPath(pathname)) {
    return NextResponse.next();
  }

  const session = await auth();

  if (!session?.externalIdentity) {
    // MODULE 02/13: the dedicated login page is the single front door for
    // signing in — the Auth.js fallback page is not. The original destination
    // rides along as a path-only `next` parameter, which the login flow
    // carries through the OAuth round trip and `sanitizeReturnPath` judges
    // before it is ever used as a redirect target.
    const login = new URL("/login", request.nextUrl);
    login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);

    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except API routes, Next internals and static files. API routes
     * answer JSON and are authorised by the BFF; static assets carry no user
     * data, so sending them through a session read would be pure overhead.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp)$).*)",
  ],
};