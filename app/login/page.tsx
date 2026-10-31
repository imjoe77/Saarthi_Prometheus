import type { Metadata } from "next";

import LoginForm from "@/components/LoginForm";

/**
 * MODULE 02/13 — the dedicated login page.
 *
 * A server component only so it can await the optional `next` search parameter
 * (added by `proxy.ts` when a signed-out visitor is bounced from a protected
 * page) and hand it to the client flow. The page itself is public: signing in
 * is the whole point, and `/login` must never sit behind the session gate.
 */
export const metadata: Metadata = {
  title: "Login or Sign Up — PROMETHEUS",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : null;

  return <LoginForm next={next} />;
}
