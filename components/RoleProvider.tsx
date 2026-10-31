"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";

import { getMyRoles, type MyRolesResponse, type RoleName } from "@/lib/api-client";
import { hasAnyRole, isAdmin } from "@/lib/rbac";

/**
 * MODULE 13 — where the browser learns the caller's roles.
 *
 * Roles always arrive from `GET /rbac/me` through the BFF. They are never read
 * from the Auth.js session cookie, never stored in localStorage, and never
 * derived from the email or provider. The cookie is Auth.js's own encrypted
 * blob and is not a role store; a client that trusted it would be one
 * cookie-edit away from a privilege UI it should not have.
 *
 * The set in `roles` is the *session-scoped* one: the backend narrows the
 * account's held roles to the persona the user signed in as (MODULE 13), so
 * signing in as "Normal User" on an account that also holds EXPERT_TRADER
 * presents only USER here. `heldRoles` is the full grant set for UI that must
 * speak about what the account owns rather than what this session acts as
 * (e.g. "you already hold this role" on the onboarding wizard).
 *
 * While the fetch is in flight, `loading` is true so gates can render a
 * skeleton rather than flash an "Access denied" that was only a race. When
 * signed out, or when the call fails, roles are empty - deny by default.
 */
interface RolesContextValue {
  /** Effective roles for this session (scoped to the signed-in persona). */
  roles: RoleName[];
  /** Every role the account holds, ignoring the persona signed in as. */
  heldRoles: RoleName[];
  /** The persona this session signed in as, or null when none was chosen. */
  activeRole: RoleName | null;
  requestable: RoleName[];
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
  isExpert: boolean;
  isLiquidityProvider: boolean;
  hasRole: (...required: RoleName[]) => boolean;
  refresh: () => Promise<void>;
}

const RolesContext = createContext<RolesContextValue | null>(null);

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const [data, setData] = useState<MyRolesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    if (status !== "authenticated") {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const result = await getMyRoles();
      setData(result);
      setError(null);
    } catch (cause) {
      // A failed role load is not a crash: treat it as "no roles" so the UI
      // stays usable and the next navigation can retry. The API still denies.
      setData(null);
      setError(cause instanceof Error ? cause.message : "Could not load roles.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;

    if (status !== "authenticated") {
      // Clear asynchronously so this effect never sets state synchronously.
      const timer = setTimeout(() => {
        if (!active) return;
        setData(null);
        setError(null);
        setLoading(false);
      }, 0);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }

    getMyRoles()
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Could not load roles.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [status]);

  const value = useMemo<RolesContextValue>(() => {
    const roles = data?.roles ?? [];
    const heldRoles = data?.heldRoles ?? roles;
    const activeRole = data?.activeRole ?? null;
    const requestable = data?.requestable ?? [];

    return {
      roles,
      heldRoles,
      activeRole,
      requestable,
      loading: status === "loading" || loading,
      error,
      isAdmin: isAdmin(roles),
      isExpert: roles.includes("EXPERT_TRADER"),
      isLiquidityProvider: roles.includes("LIQUIDITY_PROVIDER"),
      hasRole: (...required: RoleName[]) => hasAnyRole(roles, ...required),
      refresh,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, loading, error, status]);

  return <RolesContext.Provider value={value}>{children}</RolesContext.Provider>;
}

/** Reads the role context. Safe outside the provider: returns an empty deny. */
export function useRoles(): RolesContextValue {
  const context = useContext(RolesContext);
  if (!context) {
    return {
      roles: [],
      heldRoles: [],
      activeRole: null,
      requestable: [],
      loading: false,
      error: null,
      isAdmin: false,
      isExpert: false,
      isLiquidityProvider: false,
      hasRole: () => false,
      refresh: async () => undefined,
    };
  }
  return context;
}
