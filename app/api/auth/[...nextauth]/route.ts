import { handlers } from "@/lib/auth";

/**
 * MODULE 02 — the Auth.js catch-all route.
 *
 * Auth.js owns everything under this prefix: `/api/auth/signin`, the
 * `/api/auth/callback/google` and `/api/auth/callback/github` redirects, session
 * reads and sign-out. The handlers object is NextAuth's own; none of this
 * application's logic lives inside it.
 *
 * The callback paths above are what must be registered with each provider's
 * console, using the same host the browser used to reach this app.
 */
export const { GET, POST } = handlers;