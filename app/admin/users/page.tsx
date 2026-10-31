"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  X,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  AdminAuditLog,
  AdminRoleRequest,
  AdminUser,
  ApiError,
  adminDecideRoleRequest,
  adminGrantRole,
  adminListAuditLogs,
  adminListRoleRequests,
  adminListUsers,
  adminRevokeRole,
  type RoleName,
} from "@/lib/api-client";

/**
 * MODULE 13 — the admin Users & Roles screen.
 *
 * Three panels: users with their current roles, the pending role-request
 * queue, and the audit trail. Grant and revoke are available for
 * EXPERT_TRADER and LIQUIDITY_PROVIDER only - the UI never offers
 * PLATFORM_ADMIN, and the backend refuses it even if a caller forges the
 * request. There is no bulk action: each grant is one deliberate click and one
 * audit row.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

const GRANTABLE: Array<Exclude<RoleName, "USER" | "PLATFORM_ADMIN">> = [
  "EXPERT_TRADER",
  "LIQUIDITY_PROVIDER",
];

export default function AdminUsersPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [requests, setRequests] = useState<AdminRoleRequest[]>([]);
  const [audit, setAudit] = useState<AdminAuditLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [userRows, requestRows, auditRows] = await Promise.all([
        adminListUsers(),
        adminListRoleRequests("PENDING"),
        adminListAuditLogs(),
      ]);
      setUsers(userRows);
      setRequests(requestRows);
      setAudit(auditRows.slice(0, 30));
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([adminListUsers(), adminListRoleRequests("PENDING"), adminListAuditLogs()])
      .then(([userRows, requestRows, auditRows]) => {
        if (!active) return;
        setUsers(userRows);
        setRequests(requestRows);
        setAudit(auditRows.slice(0, 30));
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(messageFor(cause));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  const grant = async (userId: string, role: Exclude<RoleName, "USER" | "PLATFORM_ADMIN">) => {
    setBusyId(userId);
    setError(null);
    setFlash(null);
    try {
      await adminGrantRole(userId, role);
      setFlash(`Granted ${role}.`);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (userId: string, role: RoleName) => {
    setBusyId(userId);
    setError(null);
    setFlash(null);
    try {
      await adminRevokeRole(userId, role);
      setFlash(`Revoked ${role}.`);
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
  ) => {
    setBusyId(requestId);
    setError(null);
    setFlash(null);
    try {
      await adminDecideRoleRequest(requestId, decision);
      setFlash(decision === "APPROVED" ? "Request approved." : "Request rejected.");
      await load();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell>
      <RoleGate roles={["PLATFORM_ADMIN"]}>
        <div className="p-6">
          <Link
            href="/admin"
            className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white mb-6"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Admin
          </Link>

          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
                <Shield className="w-3.5 h-3.5" />
                Admin · Users &amp; roles
              </div>
              <h1 className="text-2xl font-bold text-white">Users &amp; roles</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Grant or revoke Expert Trader and Liquidity Provider. PLATFORM_ADMIN is never
                granted through this screen.
              </p>
            </div>
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#EF4444]">
              <AlertTriangle className="w-4 h-4 inline mr-2" />
              {error}
            </div>
          )}
          {flash && (
            <div className="mb-4 rounded-xl border border-[#00D26A]/40 bg-[#00D26A]/10 p-3 text-sm text-[#00D26A]">
              <Check className="w-4 h-4 inline mr-2" />
              {flash}
            </div>
          )}

          {status === "loading" && (
            <div className="space-y-3" aria-busy="true">
              <div className="h-24 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "ready" && (
            <div className="space-y-6">
              {/* Role requests */}
              <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#F59E0B]" />
                  Pending role requests
                </h2>
                {requests.length === 0 ? (
                  <p className="text-sm text-[#6B7280]">No pending requests.</p>
                ) : (
                  <ul className="space-y-2">
                    {requests.map((request) => (
                      <li
                        key={request.id}
                        className="flex items-center justify-between gap-3 border-b border-[#1B2028] pb-2 last:border-0"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-white truncate">{request.user.email}</div>
                          <div className="text-xs text-[#9CA3AF]">
                            Requested <span className="font-mono text-[#FF5A1F]">{request.role}</span>
                            {request.note ? ` · ${request.note}` : ""}
                          </div>
                        </div>
                        <div className="flex gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={busyId === request.id}
                            onClick={() => void decide(request.id, "APPROVED")}
                            className="inline-flex items-center gap-1 bg-[#00D26A] hover:bg-[#00B85C] text-[#0B0D10] px-2.5 py-1 rounded text-xs font-bold disabled:opacity-50"
                          >
                            {busyId === request.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Check className="w-3 h-3" />
                            )}
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busyId === request.id}
                            onClick={() => void decide(request.id, "REJECTED")}
                            className="inline-flex items-center gap-1 bg-[#14181F] border border-[#222834] hover:border-[#EF4444]/40 text-[#EF4444] px-2.5 py-1 rounded text-xs font-semibold disabled:opacity-50"
                          >
                            <X className="w-3 h-3" />
                            Reject
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Users */}
              <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-3">Users</h2>
                {users.length === 0 ? (
                  <p className="text-sm text-[#6B7280]">No users yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#6B7280] uppercase text-[10px] tracking-wider">
                          <th className="text-left pb-2">Email</th>
                          <th className="text-left pb-2">Roles</th>
                          <th className="text-left pb-2">Joined</th>
                          <th className="text-right pb-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((user) => (
                          <tr key={user.id} className="border-t border-[#1B2028]">
                            <td className="py-2 text-white max-w-[220px] truncate">{user.email}</td>
                            <td className="py-2">
                              <div className="flex flex-wrap gap-1">
                                {user.roles.map((role) => (
                                  <span
                                    key={role}
                                    className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                                      role === "PLATFORM_ADMIN"
                                        ? "border-[#EF4444]/40 text-[#EF4444]"
                                        : role === "EXPERT_TRADER"
                                          ? "border-[#FF5A1F]/40 text-[#FF5A1F]"
                                          : role === "LIQUIDITY_PROVIDER"
                                            ? "border-[#00D26A]/40 text-[#00D26A]"
                                            : "border-[#6B7280]/40 text-[#9CA3AF]"
                                    }`}
                                  >
                                    {role}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-2 text-[#9CA3AF]">
                              {new Date(user.createdAt).toLocaleDateString()}
                            </td>
                            <td className="py-2 text-right">
                              <div className="inline-flex flex-wrap gap-1 justify-end">
                                {GRANTABLE.map((role) =>
                                  user.roles.includes(role) ? (
                                    <button
                                      key={`revoke-${role}`}
                                      type="button"
                                      disabled={busyId === user.id}
                                      onClick={() => void revoke(user.id, role)}
                                      className="px-1.5 py-0.5 rounded border border-[#222834] text-[10px] text-[#EF4444] hover:border-[#EF4444]/40 disabled:opacity-50"
                                    >
                                      Revoke {role.replace("_", " ")}
                                    </button>
                                  ) : (
                                    <button
                                      key={`grant-${role}`}
                                      type="button"
                                      disabled={busyId === user.id}
                                      onClick={() => void grant(user.id, role)}
                                      className="px-1.5 py-0.5 rounded border border-[#222834] text-[10px] text-[#9CA3AF] hover:text-white hover:border-[#323B4C] disabled:opacity-50"
                                    >
                                      Grant {role.replace("_", " ")}
                                    </button>
                                  ),
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Audit */}
              <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-3">Recent audit</h2>
                {audit.length === 0 ? (
                  <p className="text-sm text-[#6B7280]">No administrative actions recorded.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {audit.map((entry) => (
                      <li key={entry.id} className="text-xs flex justify-between gap-3">
                        <span className="font-mono text-[#FF5A1F]">{entry.action}</span>
                        <span className="text-[#9CA3AF] truncate">
                          {entry.actor.email} · {new Date(entry.createdAt).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
