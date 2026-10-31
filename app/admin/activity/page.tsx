"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Landmark, RefreshCw } from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  adminListAuditLogs,
  type AdminAuditLog,
} from "@/lib/api-client";

/**
 * MODULE 13 — the full administrative audit log.
 *
 * Append-only by contract on the backend; this page is a read-only view of the
 * most recent entries. There is no edit or delete control because the trail is
 * the evidence of who granted what - a screen that could rewrite it would be
 * worse than no trail at all.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function AdminActivityPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [items, setItems] = useState<AdminAuditLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await adminListAuditLogs();
      setItems(rows);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    adminListAuditLogs()
      .then((rows) => {
        if (!active) return;
        setItems(rows);
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

  const reload = useCallback(() => {
    setStatus("loading");
    setError(null);
    void load();
  }, [load]);

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
                <Landmark className="w-3.5 h-3.5" />
                Admin · Audit log
              </div>
              <h1 className="text-2xl font-bold text-white">Administrative audit</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Who granted, revoked, approved or rejected - newest first. Append-only on the
                backend.
              </p>
            </div>
            <button
              onClick={reload}
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

          {status === "loading" && (
            <div className="space-y-2" aria-busy="true">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="h-10 rounded bg-[#181D26] animate-pulse" />
              ))}
            </div>
          )}

          {status === "ready" && (
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
              {items.length === 0 ? (
                <p className="text-sm text-[#6B7280]">No administrative actions recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {items.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-start justify-between gap-4 border-b border-[#1B2028] pb-2 last:border-0 text-xs"
                    >
                      <div>
                        <span className="font-mono text-[#FF5A1F]">{entry.action}</span>
                        {entry.targetUserId && (
                          <span className="ml-2 text-[#6B7280] font-mono">
                            target {entry.targetUserId.slice(0, 8)}…
                          </span>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[#9CA3AF]">{entry.actor.email}</div>
                        <div className="text-[#6B7280]">
                          {new Date(entry.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
