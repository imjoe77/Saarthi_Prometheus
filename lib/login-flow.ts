/**
 * MODULE 02/13 — the role-intent vocabulary shared by the dedicated login flow.
 *
 * The login page lets a visitor state an *intent* (Normal User, Expert Trader,
 * Liquidity Provider, Platform Admin — each with Login and Sign Up actions).
 * That intent rides through the OAuth round trip as query parameters on the
 * callback and is reconciled on `/login/continue` against the roles the caller
 * actually holds. Nothing here can grant a role: the intent only ever *narrows*
 * the session to the surface that was clicked, and the backend decides whether
 * the account may reach it (email allowlist for EXPERT/LIQUIDITY, env-only
 * `PLATFORM_ADMIN_EMAILS` for admin, plus the one-privileged-role rule).
 */
import type { RoleName } from "@/lib/api-client";
import { sanitizeReturnPath } from "@/lib/return-path";

/** The four intents offered on `/login`. */
export type LoginRole = "USER" | "EXPERT_TRADER" | "LIQUIDITY_PROVIDER" | "PLATFORM_ADMIN";

/** Sign-in intent vs new-account intent. Both run the same OAuth exchange. */
export type LoginMode = "login" | "signup";

const LOGIN_ROLES: readonly LoginRole[] = [
  "USER",
  "EXPERT_TRADER",
  "LIQUIDITY_PROVIDER",
  "PLATFORM_ADMIN",
];

/** Display names for every role, including the ones that are never cards. */
export const ROLE_LABELS: Record<RoleName, string> = {
  USER: "Normal User",
  EXPERT_TRADER: "Expert Trader",
  LIQUIDITY_PROVIDER: "Liquidity Provider",
  PLATFORM_ADMIN: "Platform Admin",
};

/** Narrows a raw search-param value to a real login intent. */
export function isLoginRole(value: unknown): value is LoginRole {
  return typeof value === "string" && (LOGIN_ROLES as readonly string[]).includes(value);
}

/** Where each role's own surface lives. */
export function surfaceFor(role: LoginRole): string {
  switch (role) {
    case "EXPERT_TRADER":
      return "/expert";
    case "LIQUIDITY_PROVIDER":
      return "/liquidity";
    case "PLATFORM_ADMIN":
      return "/admin";
    default:
      return "/";
  }
}

/** Builds the continuation URL the OAuth flow returns to. */
export function continueHref(
  role: LoginRole,
  mode: LoginMode,
  returnPath: string | null,
): string {
  const params = new URLSearchParams({ role, mode });
  const safeReturn = sanitizeReturnPath(returnPath);
  if (safeReturn) {
    params.set("next", safeReturn);
  }
  return `/login/continue?${params.toString()}`;
}

/**
 * sessionStorage key carrying the denial message across the sign-out.
 *
 * When a visitor chooses an elevated role their email is not authorized for,
 * the session is ended immediately and the landing page announces the refusal.
 * The key maps to the denied role's display name — never to the visitor's
 * email, which has no business persisting after the denial.
 */
export const ACCESS_DENIED_STORAGE_KEY = "prometheus.accessDenied";

/**
 * sessionStorage key carrying the backend's *reason* for the denial, when it
 * supplied one (e.g. the one-privileged-role rule's "try a different account"
 * message). Same one-shot consumption as the notice itself; when absent the
 * notice falls back to its generic wording for the denied role.
 */
export const ACCESS_DENIED_REASON_STORAGE_KEY = "prometheus.accessDeniedReason";
