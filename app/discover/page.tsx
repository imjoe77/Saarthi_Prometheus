"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Compass,
  Layers,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import AppShell from "@/components/AppShell";
import RoleGate from "@/components/RoleGate";
import { useRoles } from "@/components/RoleProvider";
import {
  ApiError,
  discoverStrategies,
  type PublicStrategyPage,
  type PublicStrategySummary,
} from "@/lib/api-client";

/**
 * MODULE 13 — the public strategy catalogue for every signed-in user.
 *
 * Discovery stays authenticated (the API requires a session) and is no longer
 * mixed with owner CRUD: managing your own strategies lives under
 * `/expert/strategies` for EXPERT_TRADER and PLATFORM_ADMIN. A plain USER can
 * browse here, follow a public strategy from Copy Trading, and request expert
 * access from Preferences.
 *
 * What is deliberately absent: return, P&L, Sharpe, drawdown, risk, followers
 * or AUM. No price source or trade history exists for a public listing yet, so
 * every one of those would be an invented number.
 */

type LoadStatus = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details?.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  return "Something went wrong while talking to the Prometheus API.";
}

export default function DiscoverPage() {
  const { isExpert, isAdmin } = useRoles();
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [page, setPage] = useState<PublicStrategyPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageParam, setPageParam] = useState(1);

  const load = useCallback(async () => {
    try {
      const result = await discoverStrategies({ page: pageParam, limit: 20 });
      setPage(result);
      setStatus("ready");
    } catch (cause) {
      setError(messageFor(cause));
      setStatus("error");
    }
  }, [pageParam]);

  useEffect(() => {
    let active = true;
    discoverStrategies({ page: pageParam, limit: 20 })
      .then((result) => {
        if (!active) return;
        setPage(result);
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
  }, [pageParam]);

  return (
    <AppShell>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-[#6B7280] uppercase mb-2">
              <Compass className="w-3.5 h-3.5" />
              Discover
            </div>
            <h1 className="text-2xl font-bold text-white">Public strategies</h1>
            <p className="mt-1 text-sm text-[#9CA3AF]">
              Browse what other traders have published. No performance figures are shown because
              none are measured yet.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(isExpert || isAdmin) && (
              <Link
                href="/expert/strategies"
                className="inline-flex items-center gap-1.5 bg-[#14181F] border border-[#222834] hover:border-[#323B4C] text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                My strategies
              </Link>
            )}
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 p-4 text-sm text-[#EF4444]">
            <AlertTriangle className="w-4 h-4 inline mr-2" />
            {error}
          </div>
        )}

        {status === "loading" && (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-20 rounded-xl bg-[#181D26] animate-pulse" />
            ))}
          </div>
        )}

        {status === "ready" && page && (
          <>
            {page.items.length === 0 ? (
              <div className="rounded-xl border border-[#262E3B] bg-[#12161D] p-10 text-center">
                <Layers className="w-10 h-10 text-[#6B7280] mx-auto mb-3" />
                <h2 className="text-lg font-semibold text-white">Nothing published yet</h2>
                <p className="mt-1 text-sm text-[#9CA3AF]">
                  When an expert publishes a public strategy, it will appear here.
                </p>
                {(isExpert || isAdmin) && (
                  <Link
                    href="/expert/strategies/new"
                    className="mt-4 inline-flex items-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B14] text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create a strategy
                  </Link>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {page.items.map((strategy: PublicStrategySummary) => (
                  <div
                    key={strategy.id}
                    className="rounded-xl border border-[#262E3B] bg-[#12161D] p-4 flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-white truncate">{strategy.name}</h3>
                      {strategy.description && (
                        <p className="mt-1 text-xs text-[#9CA3AF] line-clamp-2">
                          {strategy.description}
                        </p>
                      )}
                      <p className="mt-2 text-[10px] font-mono text-[#6B7280]">
                        Published {new Date(strategy.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Link
                      href={`/strategies/${strategy.id}`}
                      className="shrink-0 text-xs text-[#FF5A1F] hover:underline"
                    >
                      View
                    </Link>
                  </div>
                ))}
              </div>
            )}

            {page.totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  onClick={() => setPageParam((value) => Math.max(1, value - 1))}
                  disabled={pageParam <= 1}
                  className="text-xs text-[#9CA3AF] hover:text-white disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-xs text-[#6B7280] font-mono">
                  {page.page} / {page.totalPages}
                </span>
                <button
                  onClick={() => setPageParam((value) => Math.min(page.totalPages, value + 1))}
                  disabled={pageParam >= page.totalPages}
                  className="text-xs text-[#9CA3AF] hover:text-white disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}

        {/* Expert CTA for plain users */}
        <RoleGate
          roles={["EXPERT_TRADER", "PLATFORM_ADMIN"]}
          denied={
            <div className="mt-10 rounded-xl border border-[#262E3B] bg-[#12161D] p-5">
              <h3 className="text-sm font-semibold text-white">Want to publish your own?</h3>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Expert Trader access lets you create and manage strategies. Request it from
                Preferences.
              </p>
              <Link
                href="/preferences"
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-[#FF5A1F] hover:underline"
              >
                Request access
              </Link>
            </div>
          }
        >
          <div className="mt-10 rounded-xl border border-[#FF5A1F]/30 bg-[#FF5A1F]/5 p-5">
            <h3 className="text-sm font-semibold text-white">You can publish strategies</h3>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              As an Expert Trader you can create, edit and publish strategies from the Expert
              section.
            </p>
            <Link
              href="/expert/strategies"
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-[#FF5A1F] hover:underline"
            >
              Open Expert Strategies
            </Link>
          </div>
        </RoleGate>
      </div>
    </AppShell>
  );
}
