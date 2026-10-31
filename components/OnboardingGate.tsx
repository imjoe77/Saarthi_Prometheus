"use client";

import React, { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import { getMyProfile } from "@/lib/api-client";

/**
 * MODULE 13 — a first sign-in lands on the onboarding wizard, not the dashboard.
 *
 * The wizard at `/onboarding` is where a new account answers the baseline
 * questionnaire and picks how it will use the platform; before this gate it
 * was reachable only by a link buried in Preferences, so almost nobody saw it.
 * The gate runs after authentication, reads the caller's profile through the
 * BFF, and sends an account with no `onboardingCompletedAt` to the wizard.
 *
 * Properties that matter:
 *
 *  - It re-checks on every navigation (the effect keys on the pathname), so
 *    the moment onboarding completes, the next navigation sees the fresh
 *    answer instead of redirecting back into the wizard.
 *  - `/onboarding` itself is exempt, so the redirect can never loop.
 *  - `/login` and `/login/continue` are exempt too: the dedicated login flow
 *    must run to completion (including its Access Denied panel for a chosen
 *    role the caller does not hold) without being hijacked mid-decision. The
 *    continuation page checks onboarding itself before it routes anywhere,
 *    and every other destination re-runs this gate.
 *  - A failed profile read never redirects: a transient API error must not
 *    lock a signed-in user out of the app. The wizard's own page surfaces
 *    load errors where they actually occur.
 *  - It renders children untouched and sets no state during render: it is a
 *    side-effect on navigation, not a loading screen.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status !== "authenticated") return;
    if (pathname === "/onboarding") return;
    if (pathname === "/login" || pathname.startsWith("/login/")) return;

    let active = true;
    getMyProfile()
      .then((profile) => {
        if (!active) return;
        if (!profile.onboardingCompletedAt) {
          router.replace("/onboarding");
        }
      })
      .catch(() => {
        // Fail open: without a confirmed "not completed" answer, stay put.
      });

    return () => {
      active = false;
    };
  }, [status, pathname, router]);

  return <>{children}</>;
}

export default OnboardingGate;
