import { NextResponse } from "next/server";

import { ensureAccessToken } from "@/lib/access-token-cookie";
import { getApiBaseUrl } from "@/lib/auth-env";

/**
 * MODULE 02 — the BFF proxy.
 *
 * Every call from the browser to the NestJS API goes through here. The browser
 * never learns the backend's address, never holds a bearer token, and never
 * chooses its own identity. It says what it wants in the path and the server
 * decides what that means in terms of a Prometheus user.
 *
 * Concretely, per request:
 *
 *  1. Require a session. Without one there is no identity to act as, so there is
 *     nothing to proxy.
 *  2. Mint a short-lived RS256 access token for the session's provider identity.
 *  3. Forward the request to the backend with that token as a Bearer credential.
 *  4. Return the backend's answer, plus a correlation id.
 *
 * The path is concatenated onto a fixed base URL. It is never treated as a URL in
 * its own right, so `..` segments and absolute URLs cannot redirect the request
 * somewhere else - that would turn this proxy into an open relay.
 *
 * Request headers are not forwarded wholesale. Only `content-type` passes
 * through, because forwarding `authorization` or `cookie` would let a caller
 * substitute their own credential for the one the server vouched for.
 */

/** NestJS's global route prefix. Kept here so it is stated exactly once. */
const API_PREFIX = "api";

/** Methods the proxy will relay. Anything else is refused without a round trip. */
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: RouteContext) {
  return proxy(request, context, "GET");
}

export async function POST(request: Request, context: RouteContext) {
  return proxy(request, context, "POST");
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxy(request, context, "PATCH");
}

export async function PUT(request: Request, context: RouteContext) {
  return proxy(request, context, "PUT");
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxy(request, context, "DELETE");
}

async function proxy(request: Request, context: RouteContext, method: string) {
  if (!ALLOWED_METHODS.has(method)) {
    return problem(405, "This method cannot be proxied to the Prometheus API.");
  }

  const token = await ensureAccessToken();

  if (!token) {
    return problem(401, "Sign in to use the Prometheus API.");
  }

  const { path } = await context.params;

  let target: URL;

  try {
    target = buildTargetUrl(path, new URL(request.url).search);
  } catch {
    return problem(400, "The requested API path is not valid.");
  }

  const contentType = request.headers.get("content-type");
  const body = method === "GET" || method === "DELETE" ? undefined : await request.arrayBuffer();

  let upstream: Response;

  try {
    upstream = await fetch(target, {
      method,
      headers: {
        accept: "application/json",
        // The browser's own `authorization` and `cookie` headers are never
        // relayed: the credential used is the one minted above, never one the
        // caller supplied.
        ...(contentType ? { "content-type": contentType } : {}),
        authorization: `Bearer ${token}`,
      },
      body,
      // The API is reached server to server on the same host; a cached answer
      // would be a different user's answer.
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    // The backend being unreachable is an operational fact, not something to
    // pass to the browser as though it came from the API.
    console.error("[bff] backend unreachable", error instanceof Error ? error.message : "unknown error");
    return problem(502, "The Prometheus API is not reachable right now.");
  }

  return relay(upstream);
}

/**
 * Builds the upstream URL from the configured base plus the caller's path.
 *
 * Each segment is decoded then re-encoded, and anything that could escape the
 * base - a traversal segment, an embedded separator - is rejected outright rather
 * than sanitised, because no legitimate API call needs one. Rejecting is safer
 * than repairing: a silently rewritten path is a path nobody reviewed.
 */
export function buildTargetUrl(segments: string[], search: string): URL {
  const url = new URL(getApiBaseUrl());

  const encoded: string[] = [];

  for (const segment of segments) {
    let decoded: string;

    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("malformed path segment");
    }

    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new Error("illegal path segment");
    }

    encoded.push(encodeURIComponent(decoded));
  }

  url.pathname = `${API_PREFIX}/${encoded.join("/")}`;
  url.search = search;

  return url;
}

/** Passes the backend's status, body and correlation id back to the caller. */
async function relay(upstream: Response): Promise<Response> {
  const payload = await upstream.text();
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });

  const requestId = upstream.headers.get("x-request-id");
  if (requestId) headers.set("x-request-id", requestId);

  return new Response(payload, { status: upstream.status, headers });
}

/** A response this proxy produced itself, in the same shape the backend uses. */
function problem(status: number, message: string): NextResponse {
  return NextResponse.json(
    { code: status === 401 ? "UNAUTHENTICATED" : "PROXY_ERROR", message },
    { status },
  );
}