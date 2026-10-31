"use client";

import React from "react";
import Link from "next/link";

import { useRoles } from "@/components/RoleProvider";
import type { RoleName } from "@/lib/api-client";

interface RoleGateProps {
  /** Roles that unlock the content. Any one is enough. */
  roles: RoleName[];
  children: React.ReactNode;
  /** Shown while the role fetch is in flight, so nothing flashes denied. */
  fallback?: React.ReactNode;
  /** Shown when the caller holds none of the required roles. */
  denied?: React.ReactNode;
}

/**
 * MODULE 13 — the client-side route/content gate.
 *
 * Hiding a control is a courtesy, never the boundary: the backend's RolesGuard
 * is what actually refuses the request. This component exists so a signed-in
 * user does not click into a guaranteed 403, and so an admin's nav stays free
 * of links they should not be using.
 *
 * While roles are still loading it renders `fallback` (a skeleton by default)
 * rather than `denied`, because a race must not look like an authorization
 * failure.
 */
export default function RoleGate({ roles, children, fallback, denied }: RoleGateProps) {
  const { hasRole, loading } = useRoles();

  if (loading) {
    return <>{fallback ?? <DefaultSkeleton />}</>;
  }

  if (!hasRole(...roles)) {
    return <>{denied ?? <DefaultDenied />}</>;
  }

  return <>{children}</>;
}

function DefaultSkeleton() {
  return (
    <div className="space-y-4 p-6" aria-busy="true" aria-live="polite">
      <div className="h-8 w-64 rounded bg-[#181D26] animate-pulse" />
      <div className="h-4 w-96 max-w-full rounded bg-[#181D26] animate-pulse" />
      <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
    </div>
  );
}

function DefaultDenied() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-[#262E3B] bg-[#12161D] p-6 text-center">
        <h2 className="text-lg font-semibold text-white">Access denied</h2>
        <p className="mt-2 text-sm text-[#9CA3AF]">
          Your account does not have permission to view this page. If you believe this is a
          mistake, request access from{" "}
          <Link href="/preferences" className="underline font-semibold text-white hover:text-[#FF5A1F]">
            Preferences
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
