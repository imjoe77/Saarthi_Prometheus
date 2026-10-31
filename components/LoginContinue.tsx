"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowLeft,
  CircleUserRound,
  Loader2,
  ShieldAlert,
} from "lucide-react";

import { useRoles } from "@/components/RoleProvider";
import {
  ApiError,
  authorizeMyRole,
  createRoleRequest,
  getMyProfile,
} from "@/lib/api-client";
import {
  ACCESS_DENIED_REASON_STORAGE_KEY,
  ACCESS_DENIED_STORAGE_KEY,
  ROLE_LABELS,
  surfaceFor,
  type LoginMode,
  type LoginRole,
} from "@/lib/login-flow";
import { clearApiToken } from "@/lib/auth-actions";
import { sanitizeReturnPath } from "@/lib/return-path";

/**
 * MODULE 13 — where a role intent meets what the account is allowed to be.
 *
 * The OAuth round trip lands here with `?role=&mode=` (and an optional `next`
 * the proxy added when the visitor was bounced from a protected page). The
 * decision is made through the BFF — never from the URL, which the visitor
 * controls:
 *
 *  - Incomplete onboarding wins first: the wizard sends the account to
 *    `/onboarding`. The OnboardingGate exempts `/login/*` precisely so this
 *    page owns the check.
 *  - A held role routes to its own surface — or to `next`, when the visitor
 *    was bounced from somewhere specific. Every intent is scoped this way:
 *    clicking Platform Admin opens `/admin`, clicking Expert Trader opens
 *    `/expert`, and the session acts as that persona alone. The backend's
 *    answer is the only basis for routing.
 *  - The USER intent routes to the normal dashboard for anyone.
 *  - An elevated intent the caller does not hold is decided by the backend's
 *    email allowlist (`GET /rbac/authorize`): a listed email has the role
 *    granted on first use (`POST /rbac/role-requests` auto-approves it), a
 *    non-listed one is denied — the account's cookies are cleared, the
 *    session is signed out, and the landing page announces the refusal,
 *    including the backend's reason when it supplied one (e.g. the
 *    one-privileged-role rule's "try a different account"). The visitor's
 *    email is never shown: by the time the notice renders, there is no
 *    session to name.
 */

type ProfileCheck = "checking" | "complete" | "incomplete" | "unknown";
type ElevateState = "idle" | "checking" | "denied" | "failed";
type GrantState = "idle" | "granting" | "failed";

interface LoginContinueProps {
  role: LoginRole;
  mode: LoginMode;
  next: string | null;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function LoginContinue({ role, mode, next }: LoginContinueProps) {
  const router = useRouter();
  const { status, update: updateSession } = useSession();
  const {
    loading: rolesLoading,
    error: rolesError,
    hasRole,
    isAdmin,
    refresh: refreshRoles,
  } = useRoles();

  const returnPath = sanitizeReturnPath(next);
  const destination = returnPath ?? surfaceFor(role);
  const label = ROLE_LABELS[role];

  const [profile, setProfile] = useState<ProfileCheck>("checking");
  const [elevation, setElevation] = useState<ElevateState>("idle");
  const [grantState, setGrantState] = useState<GrantState>("idle");
  const [grantMessage, setGrantMessage] = useState<string | null>(null);

  // One per page load: this decision is made once and the outcomes are hard
  // navigations (route, sign-out) that unmount the page.
  const elevationStartedRef = useRef(false);
  const intentRecordedRef = useRef(false);

  // How the persona recording is going; only "recorded" may route.
  const [intent, setIntent] = useState<"idle" | "recording" | "recorded" | "failed">("idle");

  /**
   * Records the chosen persona into the Auth.js session (MODULE 13).
   *
   * This is the whole point of the page: without it the `?role=` intent dies
   * here and the account keeps behaving as every role it holds. The update
   * writes `loginRole` into the session JWT; the BFF then mints each API access
   * token with that claim and the backend narrows the account's roles to it.
   *
   * Runs once per page load, and refreshes the role cache afterwards so the
   * scoping is visible to the routing decision below and to the destination
   * page. If the update fails the session stays unscoped (the pre-scoping
   * behaviour), and the visitor is told so rather than silently routed with a
   * persona that was never recorded.
   */
  useEffect(() => {
    if (status !== "authenticated") return;
    if (intentRecordedRef.current) return;
    intentRecordedRef.current = true;

    void (async () => {
      setIntent("recording");
      try {
        await updateSession({ loginRole: role });
        setIntent("recorded");
        await refreshRoles();
      } catch {
        setIntent("failed");
      }
    })();
  }, [status, role, updateSession, refreshRoles]);

  // A signed-out visitor cannot continue: back to the dedicated login page.
  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  // Onboarding wins over role routing: a brand-new account must visit the
  // wizard first. Fail open on error — the destination page re-checks anyway.
  useEffect(() => {
    if (status !== "authenticated") return;
    let active = true;
    getMyProfile()
      .then((result) => {
        if (!active) return;
        setProfile(result.onboardingCompletedAt ? "complete" : "incomplete");
      })
      .catch(() => {
        if (!active) return;
        setProfile("unknown");
      });
    return () => {
      active = false;
    };
  }, [status]);

  // The routing effect. USER needs no role confirmation (its surface is the
  // ungated dashboard); elevated roles need /rbac/me to have answered. It runs
  // only once the persona is actually *recorded*, so the destination never
  // renders — even for a frame — as the wrong role, and a failed recording
  // stops here on the honest failure screen instead of proceeding unscoped.
  const routed = role === "USER" || isAdmin || hasRole(role);
  useEffect(() => {
    if (status !== "authenticated") return;
    if (intent !== "recorded") return;
    if (profile === "checking") return;
    if (profile === "incomplete") {
      router.replace("/onboarding");
      return;
    }
    if (role === "USER") {
      router.replace(destination);
      return;
    }
    if (rolesLoading || rolesError) return;
    if (routed) {
      router.replace(destination);
    }
  }, [status, intent, profile, role, rolesLoading, rolesError, routed, destination, router]);

  // The elevation decision, made once for an elevated intent the caller does
  // not hold: ask the backend whether this email may self-authorize.
  useEffect(() => {
    if (status !== "authenticated") return;
    if (intent !== "recorded") return;
    if (profile !== "complete") return;
    if (role === "USER" || routed || rolesLoading || rolesError) return;
    if (elevationStartedRef.current) return;
    elevationStartedRef.current = true;

    void (async () => {
      setElevation("checking");
      // Narrowed once here: this effect only ever runs for an elevated intent
      // (the USER branch returns above), and both backend calls accept every
      // elevated persona including PLATFORM_ADMIN.
      const elevated = role as Exclude<LoginRole, "USER">;
      try {
        const answer = await authorizeMyRole(elevated);

        if (!answer.authorized) {
          // Not authorized for this role: end the session entirely. The
          // notice carries the role name and the backend's reason when it
          // sent one (e.g. "try a different account") — never the visitor's
          // email — and the landing page announces it to the now-signed-out
          // visitor.
          window.sessionStorage.setItem(ACCESS_DENIED_STORAGE_KEY, label);
          if (answer.reason) {
            window.sessionStorage.setItem(ACCESS_DENIED_REASON_STORAGE_KEY, answer.reason);
          } else {
            window.sessionStorage.removeItem(ACCESS_DENIED_REASON_STORAGE_KEY);
          }
          setElevation("denied");
          try {
            await clearApiToken();
            await signOut({ redirectTo: "/" });
          } catch {
            // Even if sign-out itself fails, deny stays on record; the
            // button below still ends the visit through normal sign-out.
          }
          return;
        }

        // Allowlisted: the request auto-approves and grants. Refreshing the
        // role cache lets the routing effect above send the account on, and
        // the grant failure path keeps the visitor signed in with a message.
        setElevation("idle");
        setGrantState("granting");
        try {
          await createRoleRequest({ role: elevated });
          await refreshRoles();
          setGrantState("idle");
        } catch (cause) {
          setGrantState("failed");
          setGrantMessage(messageFor(cause));
        }
      } catch (cause) {
        setElevation("failed");
        setGrantMessage(messageFor(cause));
      }
    })();
  }, [status, intent, profile, role, rolesLoading, rolesError, routed, label, refreshRoles]);

  // ---- Render ---------------------------------------------------------------

  // While the decisions are still in flight — or an effect is about to route
  // (USER surface, onboarding, held role, granted allowlisted role) — show the
  // checking view. A denial only ever renders once every source has actually
  // answered, so a race cannot look like an authorization failure.
  if (intent !== "failed" && elevation !== "failed" && grantState !== "failed") {
    const note =
      elevation === "denied"
        ? "ACCESS DENIED — SIGNING OUT…"
        : grantState === "granting"
          ? `SETTING UP ${label.toUpperCase()} ACCESS…`
          : null;
    return <CheckingView label={label} note={note} />;
  }

  // Either the persona could not be written into the session, or the elevation
  // answer / grant failed. Both end the same way: a message and a choice, never
  // a silent redirect.
  const personaFailed = intent === "failed";

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-6">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="w-5 h-5 text-[#F59E0B]" />
            <h1 className="text-lg font-bold text-white">
              {personaFailed
                ? "Could not apply the selected role"
                : `Could not complete the ${mode === "signup" ? "sign-up" : "sign-in"}`}
            </h1>
          </div>

          <p className="text-sm text-[#9CA3AF] leading-relaxed">
            {personaFailed
              ? "The selected role could not be saved to your session, so Prometheus cannot narrow your account to it. Continue as a Normal User — the safest option — or pick a role again to retry."
              : grantMessage}
          </p>
          {!personaFailed && (
            <p className="mt-3 text-xs text-[#6B7280] leading-relaxed">
              You remain signed in as a Normal User and can continue in that role.
            </p>
          )}

          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={() => {
                // Re-scope the session to the USER persona before routing: a
                // failed elevation may have left an elevated loginRole in the
                // session that this account does not actually hold.
                void updateSession({ loginRole: "USER" })
                  .catch(() => undefined)
                  .then(() => router.replace("/"));
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#FF5A1F] hover:bg-[#E04B14] px-3.5 py-2 text-xs font-bold text-white shadow-md shadow-[#FF5A1F]/25 transition-all"
            >
              <CircleUserRound className="w-3.5 h-3.5" />
              <span>Continue as Normal User</span>
            </button>
            <Link
              href="/login"
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#222834] bg-[#14181F] hover:border-[#323B4C] px-3.5 py-2 text-xs font-semibold text-[#D1D5DB] hover:text-white transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Choose a different role</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckingView({ label, note }: { label: string; note: string | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center">
        <Loader2 className="w-5 h-5 animate-spin text-[#FF5A1F] mx-auto mb-3" />
        <p className="text-xs font-mono uppercase tracking-wider text-[#6B7280]">
          CHECKING ACCESS AS {label.toUpperCase()}…
        </p>
        {note && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-xs font-mono uppercase tracking-wider text-[#EF4444]">
            <ShieldAlert className="w-3.5 h-3.5" />
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
