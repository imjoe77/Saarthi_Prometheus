import type { Metadata } from "next";

import LoginContinue from "@/components/LoginContinue";
import { isLoginRole, type LoginMode, type LoginRole } from "@/lib/login-flow";

/**
 * MODULE 13 — the OAuth callback target of the dedicated login flow.
 *
 * Auth.js lands here with the role intent as query parameters. The values are
 * normalized defensively before the client component sees them: an unknown or
 * missing role falls back to USER, an unknown mode falls back to login, and
 * `next` is passed through raw for `sanitizeReturnPath` to judge on the client.
 * The page is not in PROTECTED_PATHS on purpose — the client component sends
 * signed-out visitors to `/login` itself, so the Auth.js fallback page never
 * becomes the front door of the login flow.
 */
export const metadata: Metadata = {
  title: "Continuing — PROMETHEUS",
  robots: { index: false, follow: false },
};

export default async function LoginContinuePage({
  searchParams,
}: {
  searchParams: Promise<{
    role?: string | string[];
    mode?: string | string[];
    next?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const role: LoginRole = isLoginRole(params.role) ? params.role : "USER";
  const mode: LoginMode = params.mode === "signup" ? "signup" : "login";
  const next = typeof params.next === "string" ? params.next : null;

  return <LoginContinue role={role} mode={mode} next={next} />;
}
