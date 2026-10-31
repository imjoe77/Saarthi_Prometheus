"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  RefreshCw,
  Shield,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import {
  ApiError,
  getLiquidityDistribution,
  type LiquidityDistribution,
  type LiquidityProviderDistribution,
} from "@/lib/api-client";

/**
 * MODULE 09/13 — the admin USDT distribution screen.
 *
 * Answers "where did the USDT come from, who contributed what, and what is
 * left after every distribution": pool totals against the configured
 * threshold, a full per-provider breakdown (pledge, distributed USDT and INR,
 * orders funded, remaining balance after allocation, share of pool, wallet),
 * and the most recent allocation slices. Every number is the backend's
 * ledger truth from `GET /liquidity/distribution` - the endpoint is
 * PLATFORM_ADMIN-only and strictly read-only, so reloading moves nothing.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

/** One stat tile - same shape the other admin screens use. */
function Fact({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn";
}) {
  const color =
    tone === "good" ? "text-[#00D26A]" : tone === "warn" ? "text-[#F59E0B]" : "text-white";
  return (
    <div className="rounded-lg border border-[#222834] bg-[#14181F] p-3">
      <p className="text-[10px] font-mono uppercase tracking-wider text-[#6B7280] font-bold">
        {label}
      </p>
      <p className={`mt-1 text-sm font-semibold break-all ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-[#6B7280] mt-0.5">{sub}</p>}
    </div>
  );
}

/** Small dim line under a table cell value. */
function Sub({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] text-[#6B7280] mt-0.5">{children}</p>;
}

function StatusChip({ status }: { status: string }) {
  const cls =
    status === "ACTIVE"
      ? "border-[#00D26A]/40 text-[#00D26A]"
      : "border-[#F59E0B]/40 text-[#F59E0B]";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${cls}`}>{status}</span>
  );
}

/** "—" plus context when a provider registered but never committed. */
function noCommitmentText(row: LiquidityProviderDistribution): string | null {
  return row.commitment ? null : "No commitment yet";
}

export default function AdminUsdtPage() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [distribution, setDistribution] = useState<LiquidityDistribution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getLiquidityDistribution();
      setDistribution(result);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, []);

  // Initial read, mirroring the other admin screens: the state updates land
  // in async callbacks, not synchronously in the effect body.
  useEffect(() => {
    let active = true;
    getLiquidityDistribution()
      .then((result) => {
        if (!active) return;
        setDistribution(result);
        setError(null);
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

  const reload = () => {
    setStatus("loading");
    setError(null);
    void load();
  };

  const totals = distribution?.totals;

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
                Admin · USDT
              </div>
              <h1 className="text-2xl font-bold text-white">USDT distribution</h1>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                How pooled USDT is distributed across liquidity providers - each provider&apos;s
                contribution, what its liquidity funded, and what remains after every allocation.
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
              <div className="h-24 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-40 rounded-xl bg-[#181D26] animate-pulse" />
              <div className="h-32 rounded-xl bg-[#181D26] animate-pulse" />
            </div>
          )}

          {status === "ready" && distribution && totals && (
            <div className="space-y-6">
              {/* Pool totals */}
              <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <ArrowLeftRight className="w-4 h-4 text-[#FF5A1F]" />
                  Pool totals
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Fact label="Pledged by providers" value={totals.totalCommittedUsdt} sub="USDT ever committed" />
                  <Fact
                    label="Distributed to orders"
                    value={totals.totalDistributedUsdt}
                    sub={`USDT · ₹${totals.distributedInr} settled`}
                  />
                  <Fact
                    label="Remaining after allocation"
                    value={totals.totalRemainingUsdt}
                    sub={`USDT · ${totals.activeRemainingUsdt} threshold-eligible`}
                  />
                  <Fact label="Withdrawn by providers" value={totals.totalWithdrawnUsdt} sub="USDT reduced back out" />
                  <Fact
                    label="Threshold status"
                    value={totals.belowThreshold ? `Short ${totals.shortfallUsdt}` : "Above threshold"}
                    sub={`Threshold ${totals.thresholdUsdt} USDT`}
                    tone={totals.belowThreshold ? "warn" : "good"}
                  />
                  <Fact
                    label="Providers"
                    value={`${totals.activeProviderCount} active / ${totals.providerCount}`}
                    sub="registered liquidity providers"
                  />
                  <Fact
                    label="Orders funded"
                    value={String(totals.ordersFunded)}
                    sub={`${totals.allocationCount} allocation slices`}
                  />
                  <Fact
                    label="Commitment engine"
                    value={totals.commitmentsEnabled ? "Enabled" : "Disabled"}
                    sub="approved EMBER slabs configured"
                    tone={totals.commitmentsEnabled ? "good" : "warn"}
                  />
                </div>
              </section>

              {/* Per-provider breakdown */}
              <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-1">
                  Provider breakdown - biggest contributor first
                </h2>
                <p className="text-[11px] text-[#6B7280] mb-3">
                  Remaining = pledged − distributed, per provider, straight from the ledger.
                </p>
                {distribution.providers.length === 0 ? (
                  <p className="text-sm text-[#6B7280]">No liquidity providers have registered yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#6B7280] uppercase text-[10px] tracking-wider">
                          <th className="text-left pb-2 pr-3">Provider</th>
                          <th className="text-right pb-2 pr-3">Pledged</th>
                          <th className="text-right pb-2 pr-3">Distributed</th>
                          <th className="text-right pb-2 pr-3">Orders</th>
                          <th className="text-right pb-2 pr-3">Remaining</th>
                          <th className="text-right pb-2 pr-3">Withdrawn</th>
                          <th className="text-right pb-2 pr-3">LP wallet (USDT)</th>
                          <th className="text-right pb-2">Last distribution</th>
                        </tr>
                      </thead>
                      <tbody>
                        {distribution.providers.map((row) => (
                          <tr key={row.lpId} className="border-t border-[#1B2028]">
                            <td className="py-2 pr-3">
                              <div className="text-white max-w-[200px] truncate">{row.email}</div>
                              <div className="flex items-center gap-1.5 mt-1">
                                <StatusChip status={row.status} />
                                <span className="text-[10px] text-[#6B7280]">
                                  {new Date(row.registeredAt).toLocaleDateString()}
                                </span>
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-white">
                              {row.commitment?.usdtCommitted ?? "—"}
                              <div className="mt-1 ml-auto h-1 w-16 rounded bg-[#1B2028]">
                                <div
                                  className="h-1 rounded bg-[#FF5A1F]"
                                  style={{
                                    width: `${Math.min(100, Number(row.shareOfCommittedPct))}%`,
                                  }}
                                />
                              </div>
                              <Sub>
                                {noCommitmentText(row) ?? `${row.shareOfCommittedPct}% of all pledges`}
                              </Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[#00D26A]">
                              {row.contributedUsdt}
                              <Sub>₹{row.contributedInr}</Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-white">
                              {row.ordersFunded}
                              <Sub>{row.allocationCount} slices</Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-white">
                              {row.commitment?.usdtAvailable ?? "—"}
                              <Sub>{row.shareOfAvailablePct}% of remaining pool</Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[#F59E0B]">
                              {row.reducedUsdt}
                              <Sub>
                                {row.commitment
                                  ? `EMBER locked ${row.commitment.emberLocked}`
                                  : "—"}
                              </Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-white">
                              {row.wallet ? row.wallet.availableUsdt : "—"}
                              <Sub>
                                {row.wallet ? `locked ${row.wallet.lockedUsdt}` : "no wallet yet"}
                              </Sub>
                            </td>
                            <td className="py-2 text-right text-[#9CA3AF]">
                              {row.lastAllocatedAt
                                ? new Date(row.lastAllocatedAt).toLocaleString()
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Recent slices */}
              <section className="rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
                <h2 className="text-sm font-semibold text-white mb-1">Recent distributions</h2>
                <p className="text-[11px] text-[#6B7280] mb-3">
                  The latest allocation slices - which provider funded which order, at what price.
                </p>
                {distribution.recentAllocations.length === 0 ? (
                  <p className="text-sm text-[#6B7280]">
                    No USDT has been distributed to orders yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#6B7280] uppercase text-[10px] tracking-wider">
                          <th className="text-left pb-2 pr-3">Settled</th>
                          <th className="text-left pb-2 pr-3">Provider</th>
                          <th className="text-left pb-2 pr-3">Order</th>
                          <th className="text-right pb-2 pr-3">Slice</th>
                          <th className="text-right pb-2 pr-3">Price</th>
                          <th className="text-right pb-2">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {distribution.recentAllocations.map((slice) => (
                          <tr key={slice.allocationId} className="border-t border-[#1B2028]">
                            <td className="py-2 pr-3 text-[#9CA3AF]">
                              {new Date(slice.allocatedAt).toLocaleString()}
                            </td>
                            <td className="py-2 pr-3 text-white max-w-[180px] truncate">
                              {slice.providerEmail}
                            </td>
                            <td className="py-2 pr-3 font-mono text-[#9CA3AF]">
                              {slice.orderSide} {slice.orderId.slice(0, 8)}…
                              <Sub>order size {slice.orderUsdtAmount} USDT</Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-[#00D26A]">
                              {slice.usdtAmount}
                              <Sub>USDT</Sub>
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-white">
                              ₹{slice.priceInr}
                            </td>
                            <td className="py-2 text-right font-mono text-white">
                              ₹{slice.inrAmount}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[10px] text-[#6B7280] mt-3">
                  Read-only snapshot generated at {new Date(distribution.generatedAt).toLocaleString()} ·{" "}
                  GET /api/liquidity/distribution · admin-only
                </p>
              </section>
            </div>
          )}
        </div>
      </RoleGate>
    </AppShell>
  );
}
