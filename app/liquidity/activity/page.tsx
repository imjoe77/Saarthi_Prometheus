"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Droplets,
  History,
  RefreshCw,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  getLiquidityOverview,
  getMyLiquidityCommitment,
  type LiquidityMyCommitment,
  type LiquidityOverview,
} from "@/lib/api-client";

/**
 * MODULE 13 — the Liquidity Provider activity view.
 *
 * Shows the caller's own commitment state and the most recent shortfall
 * notices from the overview payload. There is no cross-LP activity feed: Module
 * 09 never exposes one user's commitment to another, and inventing a
 * leaderboards-style view here would leak operational data the API does not
 * authorise.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

function fmt(value: string, digits = 2): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

export default function LiquidityActivityPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [my, setMy] = useState<LiquidityMyCommitment | null>(null);
  const [overview, setOverview] = useState<LiquidityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [commitment, health] = await Promise.all([
        getMyLiquidityCommitment(),
        getLiquidityOverview(),
      ]);
      setMy(commitment);
      setOverview(health);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([getMyLiquidityCommitment(), getLiquidityOverview()])
      .then(([commitment, health]) => {
        if (!active) return;
        setMy(commitment);
        setOverview(health);
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

  return (
    <AppShell>
      <RoleGate roles={["LIQUIDITY_PROVIDER", "PLATFORM_ADMIN"]}>
        <div className="p-6">
          <Link
            href="/liquidity"
            className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white mb-6"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Liquidity
          </Link>

          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
                <History className="w-3.5 h-3.5" />
                Liquidity activity
              </div>
              <h1 className="text-2xl font-bold text-white">Your commitment history</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Only your own LP state and platform shortfall notices. No other provider&apos;s
                data is shown.
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

          {status === "loading" && (
            <div className="space-y-3" aria-busy="true">
              <div className="h-24 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-24 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "ready" && my && overview && (
            <div className="space-y-4">
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Droplets className="w-4 h-4 text-[#FF5A1F]" />
                  Current commitment
                </h2>
                {my.commitment ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-[11px] text-[#6B7280] uppercase">Committed</div>
                      <div className="font-mono text-white mt-0.5">
                        {fmt(my.commitment.usdtCommitted)} USDT
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#6B7280] uppercase">Available</div>
                      <div className="font-mono text-white mt-0.5">
                        {fmt(my.commitment.usdtAvailable)} USDT
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#6B7280] uppercase">Consumed</div>
                      <div className="font-mono text-white mt-0.5">
                        {fmt(my.commitment.usdtConsumed)} USDT
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#6B7280] uppercase">Opened</div>
                      <div className="text-white mt-0.5">
                        {new Date(my.commitment.committedAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[#6B7280]">No commitment has been opened yet.</p>
                )}
              </div>

              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-3">Shortfall notices</h2>
                {overview.openRequest ? (
                  <div className="rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-xs text-[#EF4444]">
                    <div className="font-semibold">OPEN</div>
                    <div className="mt-1">
                      Required {fmt(overview.openRequest.requiredUsdt)} USDT against a{" "}
                      {fmt(overview.openRequest.thresholdUsdt)} USDT threshold.
                    </div>
                    <div className="mt-1 text-[#9CA3AF]">
                      Opened {new Date(overview.openRequest.openedAt).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[#6B7280]">
                    No open shortfall notice. Notices appear here when aggregate liquidity sits at
                    or below the configured threshold.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
