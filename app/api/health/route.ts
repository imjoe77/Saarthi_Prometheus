import { NextResponse } from "next/server";

import { getApiBaseUrl } from "@/lib/auth-env";

/**
 * BFF route for the AI trade-buddy's status probe (design-integration task).
 *
 * The widget derives this URL from its answer endpoint
 * (`…/api/ai-doubt-solver` → `…/api/health`) and reads `providerConfigured` to
 * decide between "AI ready" and the not-configured label. It is public — no
 * session, no bearer token — because the widget runs before sign-in on pages
 * that allow anonymous visitors, and the payload says nothing about a user.
 *
 * When the backend answers, its health body is forwarded as-is: `status`,
 * `providerConfigured` and `aiProvider` are all computed there, so this route
 * adds no opinion of its own.
 *
 * When the backend does not answer, the body is `null`. That is deliberate and
 * worth stating plainly: the widget's only "backend is down" label comes from
 * an exception while reading the health body (`health.providerConfigured` on a
 * null value throws, and its catch renders "Backend offline"). A well-formed
 * `{ providerConfigured: false }` would instead render "Add API key", which
 * would send an operator to an `.env` file that has nothing to do with the
 * outage. The HTTP status stays 200 — this route itself is fine; it is its
 * dependency that is not — matching the backend's own convention that health is
 * reported, not enforced.
 */
export async function GET(): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(`${getApiBaseUrl()}/api/health`, {
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(null, { status: 200 });
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    return NextResponse.json(null, { status: 200 });
  }

  try {
    return NextResponse.json(JSON.parse(text), { status: 200 });
  } catch {
    return NextResponse.json(null, { status: 200 });
  }
}
