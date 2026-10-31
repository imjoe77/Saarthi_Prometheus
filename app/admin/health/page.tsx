"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  HeartPulse,
  Loader2,
  RefreshCw,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import { ApiError, requestHealth } from "@/lib/api-client";

/**
 * MODULE 13 — the admin system-health screen.
 *
 * A thin view over the backend's own `/health` probe (database connectivity and
 * latency). It reports what the probe measured and never invents a
 * green/red badge from client-side timing; the backend remains the source of
 * truth for whether the system is healthy.
 */

type LoadStatus = "loading" | "ready" | "error";

interface HealthCheck {
  name: string;
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

interface HealthPayload {
  status: "ok" | "error";
  checks: HealthCheck[];
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function AdminHealthPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await requestHealth();
      setHealth(result);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    requestHealth()
      .then((result) => {
        if (!active) return;
        setHealth(result);
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
        <div className="p-6 max-w-xl">
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
                <HeartPulse className="w-3.5 h-3.5" />
                Admin · Health
              </div>
              <h1 className="text-2xl font-bold text-white">System health</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Backend probe results. Latency is measured server-side.
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
            <div className="space-y-3" aria-busy="true">
              <div className="h-16 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-16 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "ready" && health && (
            <div className="space-y-3">
              <div
                className={`rounded-xl border p-4 flex items-center justify-between ${
                  health.status === "ok"
                    ? "border-[#00D26A]/40 bg-[#00D26A]/10"
                    : "border-[#EF4444]/40 bg-[#EF4444]/10"
                }`}
              >
                <span className="text-sm font-semibold text-white">Overall status</span>
                <span
                  className={`font-mono text-sm font-bold ${
                    health.status === "ok" ? "text-[#00D26A]" : "text-[#EF4444]"
                  }`}
                >
                  {health.status.toUpperCase()}
                </span>
              </div>

              {health.checks.map((check) => (
                <div
                  key={check.name}
                  className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 flex items-center justify-between"
                >
                  <div>
                    <div className="text-sm font-semibold text-white">{check.name}</div>
                    {check.error && (
                      <div className="text-xs text-[#EF4444] mt-0.5">{check.error}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {check.latencyMs !== undefined && (
                      <span className="text-xs font-mono text-[#6B7280]">
                        {check.latencyMs}ms
                      </span>
                    )}
                    <span
                      className={`font-mono text-xs font-bold ${
                        check.status === "up" ? "text-[#00D26A]" : "text-[#EF4444]"
                      }`}
                    >
                      {check.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {status === "ready" && !health && (
            <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-6 text-center text-sm text-[#6B7280]">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
              No health payload returned.
            </div>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
