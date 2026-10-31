/**
 * MODULE 02 — which routes need a session.
 *
 * Kept in its own module, deliberately free of `server-only` and of any React or
 * Next server import, because two very different callers need the same list:
 *
 *  - `proxy.ts`, which runs on the Node runtime on every navigation.
 *  - `lib/dal.ts`, which enforces the check next to the data.
 *
 * When those two disagreed, the optimistic redirect and the real enforcement
 * would drift, and the only symptom would be a page that renders but does not
 * work. One list, two consumers.
 *
 * Note what is *not* here: any rule about which Prometheus user may see what.
 * That is per-resource authorization belonging to the module that owns the
 * resource, and the backend is what enforces it.
 */
export const PROTECTED_PATHS = [
  "/dashboard",
  "/portfolio",
  "/wallet",
  "/strategies",
  "/copy-trading",
  "/copytrading",
  "/usdt-exchange",
  "/usdt",
  "/terminal",
  // MODULE 13 — new role-aware surfaces. Session-gated here; role-gated by
  // RoleGate on the page and by the backend's RolesGuard on every API call.
  "/discover",
  "/expert",
  "/liquidity",
  "/admin",
  "/treasury",
  "/preferences",
  "/onboarding",
  // EMBER ecosystem surfaces (session-gated here; hub/staking reads are open
  // to any signed-in user, staking writes and the blockchain surface are
  // role-gated by RoleGate on the page and by the backend's RolesGuard).
  "/ember-hub",
  "/tokenomics",
  "/ember",
  "/staking",
  "/blockchain",
  // MODULE 14 — Sentinel. Session-gated here; USER and EXPERT_TRADER by
  // RoleGate on the page and by the backend's RolesGuard on every API call.
  "/sentinel",
] as const;

/**
 * Matches a path exactly or as a prefix of a segment.
 *
 * `startsWith(path + "/")` rather than `startsWith(path)`, so `/wallets` is not
 * treated as protected because `/wallet` is.
 */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}