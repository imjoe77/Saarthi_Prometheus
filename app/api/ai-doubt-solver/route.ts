import { NextResponse } from "next/server";

import { getApiBaseUrl } from "@/lib/auth-env";

/**
 * BFF route for the AI trade-buddy widget (design-integration task).
 *
 * The widget posts from the page with plain headers and no session, so this
 * route cannot be the authenticated `/api/backend/[...path]` proxy: it forwards
 * to the public `POST /api/ai-doubt-solver` endpoint with no identity attached,
 * exactly as the widget would have called the API directly. The point of
 * keeping it here is the same as every other route: the browser never learns
 * the backend's address.
 *
 * Two translations happen on the way back:
 *
 *  - Success passes through untouched — the widget validates
 *    `{ concept, sections }` itself and truncates what it is given.
 *  - Failure is re-shaped. The backend's error envelope is
 *    `{ code, message, path, requestId, timestamp }`, while the widget reads
 *    `data.error` for its chat message (`ai-doubt-solver.js`, resolveDoubt).
 *    So a non-2xx becomes `{ error: message }` at the same status, and an
 *    unreachable backend becomes a 502 with an honest sentence — the widget
 *    then shows that text in the panel instead of a generic failure.
 *
 * The route stays response-size agnostic but bounds the request: the widget
 * itself caps the query at 1000 characters and history at 8 turns, so anything
 * meaningfully larger than ~16KB is a client that is not this widget.
 */

const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000; // the widget aborts its own fetch at 30s

interface ErrorEnvelope {
  code?: unknown;
  message?: unknown;
}

/** The sentence the widget will show the visitor. */
function errorMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const envelope = body as ErrorEnvelope;
    if (typeof envelope.message === "string" && envelope.message.trim()) {
      return envelope.message.trim();
    }
  }
  return "The AI service could not answer just now. Please try again.";
}

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text().catch(() => null);
  if (raw === null) {
    return NextResponse.json({ error: "Unable to read the request body." }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }

  try {
    JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${getApiBaseUrl()}/api/ai-doubt-solver`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "The Prometheus API is not reachable right now. Please try again shortly." },
      { status: 502 },
    );
  }

  const text = await upstream.text();

  if (upstream.ok) {
    // Passed through verbatim: the widget's contract is the backend's contract.
    return new NextResponse(text, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  return NextResponse.json({ error: errorMessage(parsed) }, { status: upstream.status });
}
